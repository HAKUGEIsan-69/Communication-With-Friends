import { useState, useEffect, useRef, useCallback } from 'react';
import { initializeApp } from 'firebase/app';
import {
  getFirestore,
  collection,
  addDoc,
  onSnapshot,
  query,
  orderBy,
  updateDoc,
  deleteDoc,
  doc,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import type { User } from 'firebase/auth';
import { GoogleGenerativeAI } from '@google/generative-ai';

// ============================================
// Types
// ============================================
interface Message {
  id: string;
  text: string;
  userId: string;
  userName: string;
  timestamp: Timestamp | null;
  isBot?: boolean;
}

interface Task {
  id: string;
  title: string;
  completed: boolean;
  assignee?: string;
  priority: 'low' | 'medium' | 'high';
  createdAt: Timestamp | null;
  createdBy: string;
}

interface AISummary {
  decisions: string[];
  todos: string[];
  pending: string[];
  timestamp: Date;
}

// ============================================
// Firebase Config (User provides their own)
// ============================================
const APP_ID = 'devstream-app';

function App() {
  // ============================================
  // State
  // ============================================
  const [firebaseConfig, setFirebaseConfig] = useState<string>('');
  const [geminiApiKey, setGeminiApiKey] = useState<string>('');
  const [isConfigured, setIsConfigured] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [userName, setUserName] = useState<string>('');
  const [isUserNameSet, setIsUserNameSet] = useState(false);

  // Chat state
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [isTyping, setIsTyping] = useState(false);

  // Task state
  const [tasks, setTasks] = useState<Task[]>([]);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [taskFilter, setTaskFilter] = useState<'all' | 'active' | 'completed'>('all');

  // AI state
  const [aiSummary, setAiSummary] = useState<AISummary | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [fileSummary, setFileSummary] = useState('');
  const [isAiLoading, setIsAiLoading] = useState(false);

  // Active channel
  const [activeChannel, setActiveChannel] = useState('general');

  // Right panel tab
  const [rightPanelTab, setRightPanelTab] = useState<'tasks' | 'summary' | 'file'>('tasks');

  // Refs
  const chatEndRef = useRef<HTMLDivElement>(null);
  const dbRef = useRef<ReturnType<typeof getFirestore> | null>(null);
  const genAIRef = useRef<GoogleGenerativeAI | null>(null);

  // ============================================
  // Firebase Initialization
  // ============================================
  const initializeFirebase = useCallback(() => {
    try {
      const config = JSON.parse(firebaseConfig);
      const app = initializeApp(config);
      dbRef.current = getFirestore(app);
      const auth = getAuth(app);

      signInAnonymously(auth).catch((error) => {
        console.error('Auth error:', error);
      });

      onAuthStateChanged(auth, (user) => {
        if (user) {
          setUser(user);
          setIsConfigured(true);
        }
      });
    } catch (error) {
      alert('Invalid Firebase config JSON');
    }
  }, [firebaseConfig]);

  // ============================================
  // Initialize Gemini
  // ============================================
  useEffect(() => {
    if (geminiApiKey) {
      genAIRef.current = new GoogleGenerativeAI(geminiApiKey);
    }
  }, [geminiApiKey]);

  // ============================================
  // Firestore Listeners
  // ============================================
  useEffect(() => {
    if (!dbRef.current || !user) return;

    // Messages listener
    const messagesRef = collection(
      dbRef.current,
      'artifacts',
      APP_ID,
      'public',
      'data',
      'channels',
      activeChannel,
      'messages'
    );
    const messagesQuery = query(messagesRef, orderBy('timestamp', 'asc'));

    const unsubMessages = onSnapshot(messagesQuery, (snapshot) => {
      const msgs: Message[] = [];
      snapshot.forEach((doc) => {
        msgs.push({ id: doc.id, ...doc.data() } as Message);
      });
      setMessages(msgs);
    });

    // Tasks listener
    const tasksRef = collection(
      dbRef.current,
      'artifacts',
      APP_ID,
      'public',
      'data',
      'tasks'
    );
    const tasksQuery = query(tasksRef, orderBy('createdAt', 'desc'));

    const unsubTasks = onSnapshot(tasksQuery, (snapshot) => {
      const taskList: Task[] = [];
      snapshot.forEach((doc) => {
        taskList.push({ id: doc.id, ...doc.data() } as Task);
      });
      setTasks(taskList);
    });

    return () => {
      unsubMessages();
      unsubTasks();
    };
  }, [user, activeChannel]);

  // Auto scroll to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ============================================
  // AI Functions
  // ============================================
  const callGemini = async (prompt: string): Promise<string> => {
    if (!genAIRef.current) {
      return 'Gemini API key not configured';
    }

    try {
      const model = genAIRef.current.getGenerativeModel({ model: 'gemini-2.5-flash-preview-05-20' });
      const result = await model.generateContent(prompt);
      return result.response.text();
    } catch (error) {
      console.error('Gemini error:', error);
      return 'AI request failed. Please check your API key.';
    }
  };

  const handleAIChat = async (userMessage: string) => {
    if (!dbRef.current || !user) return;

    setIsTyping(true);

    const messagesRef = collection(
      dbRef.current,
      'artifacts',
      APP_ID,
      'public',
      'data',
      'channels',
      activeChannel,
      'messages'
    );

    // Get recent context
    const recentMessages = messages.slice(-10).map(m => `${m.userName}: ${m.text}`).join('\n');

    const prompt = `You are DevStream AI, a helpful assistant in a developer chat app.
Be concise, friendly, and helpful. You can help with coding questions, task management, and general development discussions.

Recent conversation context:
${recentMessages}

User's question: ${userMessage}

Respond naturally as a chat participant:`;

    const response = await callGemini(prompt);

    await addDoc(messagesRef, {
      text: response,
      userId: 'ai-bot',
      userName: 'DevStream AI',
      timestamp: serverTimestamp(),
      isBot: true,
    });

    setIsTyping(false);
  };

  const summarizeConversation = async () => {
    if (!messages.length) return;

    setIsAiLoading(true);

    const conversationText = messages
      .slice(-50)
      .map(m => `${m.userName}: ${m.text}`)
      .join('\n');

    const prompt = `Analyze this development team conversation and extract:
1. DECISIONS: Key decisions that were made
2. TODO: Action items or tasks mentioned
3. PENDING: Items that need follow-up or are unresolved

Conversation:
${conversationText}

Respond in this exact JSON format:
{
  "decisions": ["decision1", "decision2"],
  "todos": ["todo1", "todo2"],
  "pending": ["pending1", "pending2"]
}

If any category is empty, use an empty array.`;

    const response = await callGemini(prompt);

    try {
      // Extract JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        setAiSummary({
          decisions: parsed.decisions || [],
          todos: parsed.todos || [],
          pending: parsed.pending || [],
          timestamp: new Date(),
        });
        setRightPanelTab('summary');
      }
    } catch (e) {
      console.error('Failed to parse summary:', e);
    }

    setIsAiLoading(false);
  };

  const summarizeFile = async () => {
    if (!fileContent.trim()) return;

    setIsAiLoading(true);

    const prompt = `Analyze and summarize this code or text content concisely.
Highlight:
- Main purpose
- Key components/functions
- Important notes or potential issues

Content:
${fileContent}

Provide a clear, developer-friendly summary:`;

    const response = await callGemini(prompt);
    setFileSummary(response);
    setIsAiLoading(false);
  };

  // ============================================
  // Message Functions
  // ============================================
  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim() || !dbRef.current || !user) return;

    const messageText = newMessage.trim();
    setNewMessage('');

    const messagesRef = collection(
      dbRef.current,
      'artifacts',
      APP_ID,
      'public',
      'data',
      'channels',
      activeChannel,
      'messages'
    );

    await addDoc(messagesRef, {
      text: messageText,
      userId: user.uid,
      userName: userName,
      timestamp: serverTimestamp(),
      isBot: false,
    });

    // Check for AI mention
    if (messageText.toLowerCase().includes('@ai') || messageText.toLowerCase().startsWith('/ai ')) {
      const query = messageText.replace(/@ai/gi, '').replace(/^\/ai /i, '').trim();
      if (query) {
        await handleAIChat(query);
      }
    }
  };

  // ============================================
  // Task Functions
  // ============================================
  const addTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTaskTitle.trim() || !dbRef.current || !user) return;

    const tasksRef = collection(
      dbRef.current,
      'artifacts',
      APP_ID,
      'public',
      'data',
      'tasks'
    );

    await addDoc(tasksRef, {
      title: newTaskTitle.trim(),
      completed: false,
      priority: 'medium',
      createdAt: serverTimestamp(),
      createdBy: userName,
    });

    setNewTaskTitle('');
  };

  const toggleTask = async (taskId: string, completed: boolean) => {
    if (!dbRef.current) return;

    const taskRef = doc(
      dbRef.current,
      'artifacts',
      APP_ID,
      'public',
      'data',
      'tasks',
      taskId
    );

    await updateDoc(taskRef, { completed: !completed });
  };

  const deleteTask = async (taskId: string) => {
    if (!dbRef.current) return;

    const taskRef = doc(
      dbRef.current,
      'artifacts',
      APP_ID,
      'public',
      'data',
      'tasks',
      taskId
    );

    await deleteDoc(taskRef);
  };

  const updateTaskPriority = async (taskId: string, priority: 'low' | 'medium' | 'high') => {
    if (!dbRef.current) return;

    const taskRef = doc(
      dbRef.current,
      'artifacts',
      APP_ID,
      'public',
      'data',
      'tasks',
      taskId
    );

    await updateDoc(taskRef, { priority });
  };

  const filteredTasks = tasks.filter((task) => {
    if (taskFilter === 'active') return !task.completed;
    if (taskFilter === 'completed') return task.completed;
    return true;
  });

  // ============================================
  // Channel List
  // ============================================
  const channels = ['general', 'development', 'design', 'random'];

  // ============================================
  // Config Screen
  // ============================================
  if (!isConfigured) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
        <div className="bg-gray-800 rounded-xl p-8 max-w-lg w-full shadow-2xl border border-gray-700">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-white mb-2">DevStream</h1>
            <p className="text-gray-400">Configure your workspace</p>
          </div>

          <div className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Firebase Config (JSON)
              </label>
              <textarea
                value={firebaseConfig}
                onChange={(e) => setFirebaseConfig(e.target.value)}
                className="w-full h-32 bg-gray-700 text-white rounded-lg p-3 border border-gray-600 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none font-mono text-sm"
                placeholder='{"apiKey": "...", "authDomain": "...", ...}'
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Gemini API Key
              </label>
              <input
                type="password"
                value={geminiApiKey}
                onChange={(e) => setGeminiApiKey(e.target.value)}
                className="w-full bg-gray-700 text-white rounded-lg p-3 border border-gray-600 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none"
                placeholder="Enter your Gemini API key"
              />
            </div>

            <button
              onClick={initializeFirebase}
              disabled={!firebaseConfig}
              className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-medium py-3 rounded-lg transition-colors"
            >
              Connect to Workspace
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ============================================
  // Username Screen
  // ============================================
  if (!isUserNameSet) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
        <div className="bg-gray-800 rounded-xl p-8 max-w-md w-full shadow-2xl border border-gray-700">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-white mb-2">Welcome to DevStream</h1>
            <p className="text-gray-400">What should we call you?</p>
          </div>

          <form onSubmit={(e) => { e.preventDefault(); if (userName.trim()) setIsUserNameSet(true); }} className="space-y-4">
            <input
              type="text"
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              className="w-full bg-gray-700 text-white rounded-lg p-3 border border-gray-600 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none text-center text-lg"
              placeholder="Your display name"
              autoFocus
            />

            <button
              type="submit"
              disabled={!userName.trim()}
              className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-medium py-3 rounded-lg transition-colors"
            >
              Enter Workspace
            </button>
          </form>
        </div>
      </div>
    );
  }

  // ============================================
  // Main App
  // ============================================
  return (
    <div className="min-h-screen bg-gray-900 flex text-gray-100">
      {/* Left Sidebar - Channels */}
      <div className="w-60 bg-gray-800 flex flex-col border-r border-gray-700">
        {/* Workspace Header */}
        <div className="p-4 border-b border-gray-700">
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <span className="text-2xl">&#9889;</span>
            DevStream
          </h1>
        </div>

        {/* Channels */}
        <div className="flex-1 overflow-y-auto p-3">
          <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2 px-2">
            Channels
          </div>
          {channels.map((channel) => (
            <button
              key={channel}
              onClick={() => setActiveChannel(channel)}
              className={`w-full text-left px-3 py-2 rounded-md mb-1 flex items-center gap-2 transition-colors ${
                activeChannel === channel
                  ? 'bg-indigo-600 text-white'
                  : 'text-gray-400 hover:bg-gray-700 hover:text-gray-200'
              }`}
            >
              <span className="text-lg">#</span>
              {channel}
            </button>
          ))}
        </div>

        {/* User Info */}
        <div className="p-3 border-t border-gray-700 bg-gray-850">
          <div className="flex items-center gap-3 px-2">
            <div className="w-8 h-8 rounded-full bg-indigo-600 flex items-center justify-center text-white font-medium">
              {userName.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-white truncate">{userName}</div>
              <div className="text-xs text-green-400">Online</div>
            </div>
          </div>
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Channel Header */}
        <div className="h-14 border-b border-gray-700 flex items-center px-4 bg-gray-800">
          <span className="text-xl text-gray-400 mr-2">#</span>
          <h2 className="font-semibold text-white">{activeChannel}</h2>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={summarizeConversation}
              disabled={isAiLoading}
              className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-600 text-white text-sm rounded-md transition-colors flex items-center gap-2"
            >
              {isAiLoading ? (
                <span className="animate-spin">&#8987;</span>
              ) : (
                <span>&#10024;</span>
              )}
              Summarize Chat
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 && (
            <div className="text-center text-gray-500 py-8">
              <p className="text-lg mb-2">No messages yet</p>
              <p className="text-sm">Start the conversation! Use @AI to chat with the bot.</p>
            </div>
          )}

          {messages.map((message) => (
            <div
              key={message.id}
              className={`flex gap-3 ${message.isBot ? 'bg-gray-800/50 -mx-4 px-4 py-3 rounded-lg' : ''}`}
            >
              <div
                className={`w-10 h-10 rounded-full flex items-center justify-center text-white font-medium flex-shrink-0 ${
                  message.isBot
                    ? 'bg-gradient-to-br from-purple-500 to-indigo-600'
                    : 'bg-gray-600'
                }`}
              >
                {message.isBot ? '&#129302;' : message.userName.charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className={`font-semibold ${message.isBot ? 'text-indigo-400' : 'text-white'}`}>
                    {message.userName}
                  </span>
                  <span className="text-xs text-gray-500">
                    {message.timestamp?.toDate?.()?.toLocaleTimeString() || 'Just now'}
                  </span>
                </div>
                <p className="text-gray-300 mt-1 whitespace-pre-wrap break-words">{message.text}</p>
              </div>
            </div>
          ))}

          {isTyping && (
            <div className="flex gap-3 items-center text-gray-400">
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center text-white">
                &#129302;
              </div>
              <div className="flex gap-1">
                <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></span>
                <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></span>
                <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></span>
              </div>
            </div>
          )}

          <div ref={chatEndRef} />
        </div>

        {/* Message Input */}
        <form onSubmit={sendMessage} className="p-4 border-t border-gray-700">
          <div className="flex gap-2">
            <input
              type="text"
              value={newMessage}
              onChange={(e) => setNewMessage(e.target.value)}
              className="flex-1 bg-gray-700 text-white rounded-lg px-4 py-3 border border-gray-600 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none"
              placeholder={`Message #${activeChannel} (use @AI to chat with bot)`}
            />
            <button
              type="submit"
              disabled={!newMessage.trim()}
              className="px-6 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
            >
              Send
            </button>
          </div>
        </form>
      </div>

      {/* Right Sidebar - Tasks & AI */}
      <div className="w-80 bg-gray-800 border-l border-gray-700 flex flex-col">
        {/* Tabs */}
        <div className="flex border-b border-gray-700">
          <button
            onClick={() => setRightPanelTab('tasks')}
            className={`flex-1 py-3 text-sm font-medium transition-colors ${
              rightPanelTab === 'tasks'
                ? 'text-indigo-400 border-b-2 border-indigo-400'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            Tasks
          </button>
          <button
            onClick={() => setRightPanelTab('summary')}
            className={`flex-1 py-3 text-sm font-medium transition-colors ${
              rightPanelTab === 'summary'
                ? 'text-indigo-400 border-b-2 border-indigo-400'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            Summary
          </button>
          <button
            onClick={() => setRightPanelTab('file')}
            className={`flex-1 py-3 text-sm font-medium transition-colors ${
              rightPanelTab === 'file'
                ? 'text-indigo-400 border-b-2 border-indigo-400'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            File AI
          </button>
        </div>

        {/* Tab Content */}
        <div className="flex-1 overflow-y-auto">
          {/* Tasks Tab */}
          {rightPanelTab === 'tasks' && (
            <div className="p-4">
              {/* Add Task Form */}
              <form onSubmit={addTask} className="mb-4">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newTaskTitle}
                    onChange={(e) => setNewTaskTitle(e.target.value)}
                    className="flex-1 bg-gray-700 text-white rounded-lg px-3 py-2 border border-gray-600 focus:border-indigo-500 outline-none text-sm"
                    placeholder="Add a task..."
                  />
                  <button
                    type="submit"
                    disabled={!newTaskTitle.trim()}
                    className="px-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-600 text-white rounded-lg transition-colors"
                  >
                    +
                  </button>
                </div>
              </form>

              {/* Filter */}
              <div className="flex gap-1 mb-4">
                {(['all', 'active', 'completed'] as const).map((filter) => (
                  <button
                    key={filter}
                    onClick={() => setTaskFilter(filter)}
                    className={`px-3 py-1 text-xs rounded-full transition-colors ${
                      taskFilter === filter
                        ? 'bg-indigo-600 text-white'
                        : 'bg-gray-700 text-gray-400 hover:text-white'
                    }`}
                  >
                    {filter.charAt(0).toUpperCase() + filter.slice(1)}
                  </button>
                ))}
              </div>

              {/* Task List */}
              <div className="space-y-2">
                {filteredTasks.length === 0 && (
                  <p className="text-gray-500 text-sm text-center py-4">No tasks</p>
                )}

                {filteredTasks.map((task) => (
                  <div
                    key={task.id}
                    className={`p-3 rounded-lg border transition-all ${
                      task.completed
                        ? 'bg-gray-700/50 border-gray-600'
                        : 'bg-gray-700 border-gray-600 hover:border-gray-500'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <button
                        onClick={() => toggleTask(task.id, task.completed)}
                        className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 mt-0.5 transition-colors ${
                          task.completed
                            ? 'bg-green-600 border-green-600 text-white'
                            : 'border-gray-500 hover:border-indigo-500'
                        }`}
                      >
                        {task.completed && <span className="text-xs">&#10003;</span>}
                      </button>
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm ${task.completed ? 'text-gray-500 line-through' : 'text-white'}`}>
                          {task.title}
                        </p>
                        <div className="flex items-center gap-2 mt-1">
                          <span className="text-xs text-gray-500">by {task.createdBy}</span>
                          <select
                            value={task.priority}
                            onChange={(e) => updateTaskPriority(task.id, e.target.value as 'low' | 'medium' | 'high')}
                            className={`text-xs px-2 py-0.5 rounded-full border-0 cursor-pointer ${
                              task.priority === 'high'
                                ? 'bg-red-500/20 text-red-400'
                                : task.priority === 'medium'
                                ? 'bg-yellow-500/20 text-yellow-400'
                                : 'bg-green-500/20 text-green-400'
                            }`}
                          >
                            <option value="low">Low</option>
                            <option value="medium">Medium</option>
                            <option value="high">High</option>
                          </select>
                        </div>
                      </div>
                      <button
                        onClick={() => deleteTask(task.id)}
                        className="text-gray-500 hover:text-red-400 transition-colors"
                      >
                        &#10005;
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Summary Tab */}
          {rightPanelTab === 'summary' && (
            <div className="p-4">
              {!aiSummary ? (
                <div className="text-center text-gray-500 py-8">
                  <p className="text-4xl mb-4">&#128202;</p>
                  <p className="text-sm">Click "Summarize Chat" to analyze the conversation</p>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="text-xs text-gray-500 text-center">
                    Generated at {aiSummary.timestamp.toLocaleTimeString()}
                  </div>

                  {/* Decisions */}
                  <div>
                    <h3 className="text-sm font-semibold text-green-400 mb-2 flex items-center gap-2">
                      <span>&#9989;</span> Decisions
                    </h3>
                    {aiSummary.decisions.length === 0 ? (
                      <p className="text-gray-500 text-sm">No decisions found</p>
                    ) : (
                      <ul className="space-y-1">
                        {aiSummary.decisions.map((item, i) => (
                          <li key={i} className="text-sm text-gray-300 pl-4 border-l-2 border-green-500/30">
                            {item}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {/* To-Dos */}
                  <div>
                    <h3 className="text-sm font-semibold text-yellow-400 mb-2 flex items-center gap-2">
                      <span>&#128203;</span> To-Do
                    </h3>
                    {aiSummary.todos.length === 0 ? (
                      <p className="text-gray-500 text-sm">No to-dos found</p>
                    ) : (
                      <ul className="space-y-1">
                        {aiSummary.todos.map((item, i) => (
                          <li key={i} className="text-sm text-gray-300 pl-4 border-l-2 border-yellow-500/30">
                            {item}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {/* Pending */}
                  <div>
                    <h3 className="text-sm font-semibold text-orange-400 mb-2 flex items-center gap-2">
                      <span>&#9203;</span> Pending
                    </h3>
                    {aiSummary.pending.length === 0 ? (
                      <p className="text-gray-500 text-sm">No pending items</p>
                    ) : (
                      <ul className="space-y-1">
                        {aiSummary.pending.map((item, i) => (
                          <li key={i} className="text-sm text-gray-300 pl-4 border-l-2 border-orange-500/30">
                            {item}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* File AI Tab */}
          {rightPanelTab === 'file' && (
            <div className="p-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Paste code or text to analyze
                </label>
                <textarea
                  value={fileContent}
                  onChange={(e) => setFileContent(e.target.value)}
                  className="w-full h-40 bg-gray-700 text-white rounded-lg p-3 border border-gray-600 focus:border-indigo-500 outline-none font-mono text-sm resize-none"
                  placeholder="Paste your code or text here..."
                />
              </div>

              <button
                onClick={summarizeFile}
                disabled={!fileContent.trim() || isAiLoading}
                className="w-full py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-600 text-white rounded-lg transition-colors flex items-center justify-center gap-2"
              >
                {isAiLoading ? (
                  <>
                    <span className="animate-spin">&#8987;</span>
                    Analyzing...
                  </>
                ) : (
                  <>
                    <span>&#10024;</span>
                    Analyze Content
                  </>
                )}
              </button>

              {fileSummary && (
                <div className="mt-4 p-4 bg-gray-700/50 rounded-lg border border-gray-600">
                  <h3 className="text-sm font-semibold text-indigo-400 mb-2">Analysis Result</h3>
                  <p className="text-sm text-gray-300 whitespace-pre-wrap">{fileSummary}</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
