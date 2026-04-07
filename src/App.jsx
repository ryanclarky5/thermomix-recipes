import { useState, useRef, useCallback, useEffect } from 'react';
import './App.css';
import { fetchRecipes, upsertRecipe, removeRecipe, DB_ENABLED } from './db';

// ─── Formatting helpers ──────────────────────────────────────────────────────

function fmtTime(seconds) {
  if (!seconds || seconds <= 0) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m > 0 && s > 0) return `${m}m ${s}s`;
  if (m > 0) return `${m} min`;
  return `${s} sec`;
}

function fmtTemp(temp) {
  if (temp === undefined || temp === null || temp === 0) return null;
  return temp >= 110 ? 'Varoma' : `${temp}°C`;
}

function fmtSpeed(speed) {
  if (speed === undefined || speed === null) return null;
  return speed >= 10 ? 'Turbo' : `Speed ${speed}`;
}

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// ─── Image compression ───────────────────────────────────────────────────────

async function compressImage(file, maxWidth = 1024, quality = 0.82) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxWidth / img.width);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          const dataUrl = e.target.result;
          const [header, base64] = dataUrl.split(',');
          const mediaType = header.match(/data:(.*);/)[1];
          resolve({ base64, mediaType, previewUrl: dataUrl });
        };
        reader.readAsDataURL(blob);
      }, 'image/jpeg', quality);
    };
    img.onerror = () => resolve(null);
    img.src = URL.createObjectURL(file);
  });
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function StepCard({ step, index }) {
  const isTM = step.type === 'thermomix';
  const temp  = fmtTemp(step.temperature);
  const time  = fmtTime(step.time);
  const speed = fmtSpeed(step.speed);
  const hasParams = isTM && (temp || time || speed);

  return (
    <div className={`step-card${isTM ? ' step-card-tm' : ' step-card-manual'}`}>
      <div className="step-card-header">
        <div className="step-card-num">{index + 1}</div>
        {isTM && <span className="step-card-badge">Thermomix</span>}
      </div>
      <p className="step-card-text">{step.text}</p>
      {hasParams && (
        <div className="step-params">
          {temp  && <div className="step-param"><span className="step-param-icon">🌡</span><span className="step-param-val">{temp}</span></div>}
          {time  && <div className="step-param"><span className="step-param-icon">⏱</span><span className="step-param-val">{time}</span></div>}
          {speed && <div className="step-param"><span className="step-param-icon">💨</span><span className="step-param-val">{speed}</span></div>}
        </div>
      )}
    </div>
  );
}

function HistoryCard({ entry, onOpen, onDelete }) {
  return (
    <div className="history-card" onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && onOpen()}>
      <div className="history-card-body">
        <div className="history-card-title">{entry.title}</div>
        <div className="history-card-meta">
          <span>👤 {entry.servings} {entry.servings === 1 ? 'serving' : 'servings'}</span>
          <span>📅 {fmtDate(entry.createdAt)}</span>
        </div>
      </div>
      <button className="history-card-delete" onClick={e => { e.stopPropagation(); onDelete(); }} aria-label="Delete">🗑</button>
    </div>
  );
}

// ─── PIN Screen ──────────────────────────────────────────────────────────────

function PinScreen({ onSuccess }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [shaking, setShaking] = useState(false);

  async function submit() {
    if (!pin.trim() || loading) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/verify-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      const data = await res.json();
      if (data.success) {
        onSuccess();
      } else {
        setError('Incorrect PIN — try again');
        setShaking(true);
        setPin('');
        setTimeout(() => setShaking(false), 500);
      }
    } catch {
      setError('Connection error');
    } finally {
      setLoading(false);
    }
  }

  function press(key) {
    if (loading) return;
    if (key === '⌫') { setPin(p => p.slice(0, -1)); setError(''); }
    else if (key === '→') { submit(); }
    else { if (pin.length >= 8) return; setPin(p => p + key); setError(''); }
  }

  const PAD = ['1','2','3','4','5','6','7','8','9','⌫','0','→'];
  const dotCount = Math.max(pin.length, 4);

  return (
    <div className="pin-screen">
      <div className="pin-logo">🍲</div>
      <h1 className="pin-title">Thermomix Recipes</h1>
      <p className="pin-subtitle">Enter your PIN to continue</p>
      <div className={`pin-dots${shaking ? ' shake' : ''}`}>
        {Array.from({ length: dotCount }, (_, i) => (
          <div key={i} className={`pin-dot${i < pin.length ? ' filled' : ''}`} />
        ))}
      </div>
      <div className="pin-error-area">
        {error && <span className="pin-error">{error}</span>}
      </div>
      <div className="pin-pad">
        {PAD.map(key => (
          <button
            key={key}
            className={`pin-key${key === '→' ? ' pin-key-enter' : ''}${key === '⌫' ? ' pin-key-back' : ''}`}
            onClick={() => press(key)}
            disabled={loading || (key === '→' && !pin)}
          >
            {loading && key === '→' ? '…' : key}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Root ────────────────────────────────────────────────────────────────────

export default function App() {
  const [authed, setAuthed] = useState(() => sessionStorage.getItem('app_authed') === '1');

  function handleAuth() {
    sessionStorage.setItem('app_authed', '1');
    setAuthed(true);
  }

  if (!authed) return <PinScreen onSuccess={handleAuth} />;
  return <MainApp />;
}

// ─── Main App ────────────────────────────────────────────────────────────────

function MainApp() {
  // Navigation
  const [tab, setTab] = useState('generate');

  // Shared recipe history (Firestore)
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(DB_ENABLED);
  const [historyError, setHistoryError] = useState('');

  // Generate flow
  const [step, setStep] = useState(1);
  const [prompt, setPrompt] = useState('');
  const [images, setImages] = useState([]);
  const [recipe, setRecipe] = useState(null);
  const [historyId, setHistoryId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [editMode, setEditMode] = useState(false);
  const [editForm, setEditForm] = useState({});
  const [result, setResult] = useState(null);
  const [isListening, setIsListening] = useState(false);

  // AI edit
  const [aiEditMode, setAiEditMode] = useState(false);
  const [aiEditPrompt, setAiEditPrompt] = useState('');
  const [aiEditing, setAiEditing] = useState(false);

  const [toast, setToast] = useState(null);

  const recognitionRef = useRef(null);
  const fileInputRef = useRef(null);

  // ── Load recipes from Firestore on mount ──────────────────────────────────
  useEffect(() => {
    if (!DB_ENABLED) return;
    fetchRecipes()
      .then(setHistory)
      .catch(e => setHistoryError(e.message))
      .finally(() => setHistoryLoading(false));
  }, []);

  // ── Toast ─────────────────────────────────────────────────────────────────
  function showToast(message, type = 'success') {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  }

  // ── History helpers ───────────────────────────────────────────────────────
  async function saveToHistory(recipeData, cookidooResult) {
    const entry = {
      id: Date.now().toString(),
      cookidooRecipeId: cookidooResult.recipeId,
      cookidooUrl: cookidooResult.url,
      createdAt: new Date().toISOString(),
      photoCount: images.length,
      title: recipeData.title,
      description: recipeData.description,
      servings: recipeData.servings,
      prepTime: recipeData.prepTime,
      totalTime: recipeData.totalTime,
      ingredients: recipeData.ingredients,
      instructions: recipeData.instructions,
    };
    await upsertRecipe(entry);
    setHistory(prev => [entry, ...prev]);
    return entry;
  }

  async function deleteFromHistory(id) {
    await removeRecipe(id);
    setHistory(prev => prev.filter(e => e.id !== id));
  }

  function openFromHistory(entry) {
    setRecipe(entry);
    setHistoryId(entry.id);
    setStep(2);
    setEditMode(false);
    setAiEditMode(false);
    setError('');
    setResult(null);
    setTab('generate');
  }

  function backToHistory() {
    setTab('myrecipes');
    setHistoryId(null);
    setRecipe(null);
    setStep(1);
    setEditMode(false);
    setAiEditMode(false);
    setError('');
  }

  // ── Voice input ───────────────────────────────────────────────────────────
  function toggleVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { alert('Voice input not supported in this browser. Try Chrome or Safari.'); return; }
    if (isListening) { recognitionRef.current?.stop(); return; }
    const recognition = new SR();
    recognition.lang = 'en-US';
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onstart = () => setIsListening(true);
    recognition.onresult = e => {
      const t = Array.from(e.results).map(r => r[0].transcript).join(' ').trim();
      setPrompt(p => p ? `${p.trimEnd()} ${t}` : t);
    };
    recognition.onerror = e => { if (e.error !== 'aborted') setIsListening(false); };
    recognition.onend = () => setIsListening(false);
    recognitionRef.current = recognition;
    try { recognition.start(); } catch { setIsListening(false); }
  }

  // ── Photos ────────────────────────────────────────────────────────────────
  const handleFileChange = useCallback(async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const toProcess = files.slice(0, 5 - images.length);
    const results = await Promise.all(toProcess.map(compressImage));
    setImages(prev => [...prev, ...results.filter(Boolean)]);
    e.target.value = '';
  }, [images.length]);

  function removeImage(index) {
    setImages(prev => prev.filter((_, i) => i !== index));
  }

  // ── Generate ──────────────────────────────────────────────────────────────
  async function generate() {
    if ((!prompt.trim() && images.length === 0) || loading) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/generate-recipe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: prompt,
          images: images.map(({ base64, mediaType }) => ({ base64, mediaType })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Generation failed');
      setRecipe(data);
      setHistoryId(null);
      setEditMode(false);
      setAiEditMode(false);
      setStep(2);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  // ── Manual edit ───────────────────────────────────────────────────────────
  function startEdit() {
    setEditForm({
      title: recipe.title,
      description: recipe.description,
      servings: String(recipe.servings),
      prepTime: String(Math.round((recipe.prepTime || 0) / 60)),
      totalTime: String(Math.round((recipe.totalTime || 0) / 60)),
      ingredientsText: recipe.ingredients.map(i => i.text).join('\n'),
      instructionsText: recipe.instructions.map((s, i) => `${i + 1}. ${s.text}`).join('\n'),
    });
    setEditMode(true);
    setAiEditMode(false);
  }

  function saveEdit() {
    setRecipe({
      ...recipe,
      title: editForm.title.trim(),
      description: editForm.description.trim(),
      servings: Math.max(1, parseInt(editForm.servings, 10) || recipe.servings),
      prepTime: (parseFloat(editForm.prepTime) || 0) * 60,
      totalTime: (parseFloat(editForm.totalTime) || 0) * 60,
      ingredients: editForm.ingredientsText
        .split('\n').map(l => l.trim()).filter(Boolean).map(text => ({ text })),
      instructions: editForm.instructionsText
        .split('\n').map(l => l.replace(/^\d+\.\s*/, '').trim()).filter(Boolean)
        .map(text => ({ text, type: 'manual' })),
    });
    setEditMode(false);
  }

  // ── AI edit ───────────────────────────────────────────────────────────────
  async function applyAiEdit() {
    if (!aiEditPrompt.trim() || aiEditing) return;
    setAiEditing(true);
    setError('');
    try {
      const res = await fetch('/api/edit-recipe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipe, instruction: aiEditPrompt }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'AI edit failed');
      setRecipe(data);
      setAiEditMode(false);
      setAiEditPrompt('');
    } catch (e) {
      setError(e.message);
    } finally {
      setAiEditing(false);
    }
  }

  // ── Send to Cookidoo (new) ────────────────────────────────────────────────
  async function sendToCookidoo() {
    if (sending) return;
    setSending(true);
    setError('');
    try {
      const res = await fetch('/api/send-to-cookidoo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipe }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to send to Cookidoo');
      await saveToHistory(recipe, data);
      setResult(data);
      setStep(3);
    } catch (e) {
      setError(e.message);
    } finally {
      setSending(false);
    }
  }

  // ── Update on Cookidoo (existing) ─────────────────────────────────────────
  async function updateOnCookidoo() {
    if (sending) return;
    setSending(true);
    setError('');
    const entry = history.find(e => e.id === historyId);
    try {
      const res = await fetch('/api/send-to-cookidoo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipe, recipeId: entry?.cookidooRecipeId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update on Cookidoo');
      const updatedEntry = {
        ...entry,
        title: recipe.title,
        description: recipe.description,
        servings: recipe.servings,
        prepTime: recipe.prepTime,
        totalTime: recipe.totalTime,
        ingredients: recipe.ingredients,
        instructions: recipe.instructions,
        updatedAt: new Date().toISOString(),
      };
      await upsertRecipe(updatedEntry);
      setHistory(prev => prev.map(e => e.id === historyId ? updatedEntry : e));
      showToast('Recipe updated on Cookidoo ✓');
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setSending(false);
    }
  }

  function reset() {
    setStep(1); setPrompt(''); setRecipe(null); setResult(null);
    setError(''); setEditMode(false); setImages([]); setHistoryId(null);
    setAiEditMode(false); setAiEditPrompt('');
  }

  const canGenerate = prompt.trim() || images.length > 0;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="app">

      {/* ── HEADER ── */}
      {tab === 'generate' && (
        <header className="app-header">
          {historyId ? (
            <button className="header-back-btn" onClick={backToHistory}>← My Recipes</button>
          ) : (
            <>
              <span className="header-logo">🍲</span>
              <div>
                <h1 className="header-title">Recipe Generator</h1>
                <p className="header-sub">Thermomix · Cookidoo</p>
              </div>
            </>
          )}
        </header>
      )}
      {tab === 'myrecipes' && (
        <header className="app-header">
          <span className="header-logo">📖</span>
          <div>
            <h1 className="header-title">My Recipes</h1>
            <p className="header-sub">{history.length} saved</p>
          </div>
        </header>
      )}

      {/* ── STEPS BAR ── */}
      {tab === 'generate' && !historyId && (
        <div className="steps-bar">
          {['Generate', 'Review', 'Done'].map((label, i) => (
            <div key={i} className={`step-item${step === i + 1 ? ' current' : ''}${step > i + 1 ? ' past' : ''}`}>
              <div className="step-circle">{step > i + 1 ? '✓' : i + 1}</div>
              <span className="step-label">{label}</span>
            </div>
          ))}
          <div className="steps-track">
            <div className="steps-fill" style={{ width: `${(step - 1) * 50}%` }} />
          </div>
        </div>
      )}

      <main className="main">

        {/* ══ GENERATE TAB ══════════════════════════════════════════════════ */}
        {tab === 'generate' && (
          <>
            {/* ── STEP 1 ── */}
            {step === 1 && (
              <div className="screen">
                <h2 className="screen-title">What would you like to make?</h2>
                <p className="screen-hint">Describe a dish, add photos of your fridge, or both.</p>

                <div className="photo-section">
                  <button className="photo-upload-btn" onClick={() => fileInputRef.current?.click()}
                    disabled={loading || images.length >= 5} type="button">
                    <span className="photo-upload-icon">📷</span>
                    {images.length === 0 ? 'Add Photos' : `Add More (${images.length}/5)`}
                  </button>
                  <input ref={fileInputRef} type="file" accept="image/*" multiple
                    className="photo-input-hidden" onChange={handleFileChange} />
                  {images.length > 0 && (
                    <div className="photo-thumbnails">
                      {images.map((img, i) => (
                        <div key={i} className="photo-thumb-wrap">
                          <img src={img.previewUrl} alt="" className="photo-thumb" />
                          <button className="photo-thumb-remove" onClick={() => removeImage(i)} type="button" aria-label="Remove">×</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <textarea
                  className="prompt-textarea"
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) generate(); }}
                  placeholder={"e.g. creamy mushroom risotto for 4 people\ne.g. quick weeknight chicken tikka masala\nor add photos and leave this empty"}
                  rows={3}
                  disabled={loading}
                />

                <button className={`mic-btn${isListening ? ' mic-listening' : ''}`} onClick={toggleVoice} type="button">
                  {isListening
                    ? <><span className="mic-pulse">●</span> Listening… tap to stop</>
                    : <><span className="mic-icon">🎤</span> Tap to speak</>}
                </button>

                {error && <div className="error-box">{error}</div>}

                <button className="btn btn-primary btn-full" onClick={generate} disabled={loading || !canGenerate}>
                  {loading
                    ? <><span className="spinner" /> {images.length > 0 ? 'Analysing photos…' : 'Generating recipe…'}</>
                    : '✨ Generate Recipe'}
                </button>
              </div>
            )}

            {/* ── STEP 2: REVIEW ── */}
            {step === 2 && recipe && !editMode && (
              <div className="screen">
                <div className="recipe-card">
                  <h2 className="recipe-title">{recipe.title}</h2>
                  <p className="recipe-desc">{recipe.description}</p>
                  <div className="recipe-meta">
                    <span>👤 {recipe.servings} {recipe.servings === 1 ? 'serving' : 'servings'}</span>
                    {recipe.prepTime > 0 && <span>🔪 {Math.round(recipe.prepTime / 60)} min prep</span>}
                    {recipe.totalTime > 0 && <span>⏱ {Math.round(recipe.totalTime / 60)} min total</span>}
                  </div>
                </div>

                <div className="recipe-section">
                  <h3 className="section-heading">Ingredients</h3>
                  <ul className="ingredient-list">
                    {recipe.ingredients.map((ing, i) => (
                      <li key={i} className="ingredient-item">{ing.text}</li>
                    ))}
                  </ul>
                </div>

                <div className="recipe-section">
                  <h3 className="section-heading">Instructions</h3>
                  <div className="step-list">
                    {recipe.instructions.map((s, i) => <StepCard key={i} step={s} index={i} />)}
                  </div>
                </div>

                {/* AI Edit panel */}
                {aiEditMode && (
                  <div className="ai-edit-panel">
                    <h3 className="ai-edit-title">✨ Edit with AI</h3>
                    <p className="ai-edit-hint">Tell Claude what to change and it'll rewrite the recipe for you.</p>
                    <textarea
                      className="ai-edit-input"
                      value={aiEditPrompt}
                      onChange={e => setAiEditPrompt(e.target.value)}
                      placeholder="e.g. make it serve 6 people&#10;e.g. make it dairy-free&#10;e.g. add more garlic and make it spicier&#10;e.g. replace chicken with tofu"
                      rows={3}
                      disabled={aiEditing}
                      autoFocus
                    />
                    {error && <div className="error-box">{error}</div>}
                    <div className="action-bar">
                      <button className="btn btn-ghost" onClick={() => { setAiEditMode(false); setAiEditPrompt(''); setError(''); }}>Cancel</button>
                      <button className="btn btn-primary" onClick={applyAiEdit} disabled={aiEditing || !aiEditPrompt.trim()}>
                        {aiEditing ? <><span className="spinner" /> Updating…</> : '✨ Apply Changes'}
                      </button>
                    </div>
                  </div>
                )}

                {!aiEditMode && error && <div className="error-box">{error}</div>}

                {!aiEditMode && (
                  <div className="action-bar">
                    {historyId
                      ? <button className="btn btn-ghost" onClick={backToHistory}>← Back</button>
                      : <button className="btn btn-ghost" onClick={() => { setStep(1); setError(''); }}>← Back</button>
                    }
                    <button className="btn btn-secondary btn-icon" onClick={() => { setAiEditMode(true); setEditMode(false); }} title="Edit with AI">✨</button>
                    <button className="btn btn-secondary btn-icon" onClick={startEdit} title="Manual edit">✏️</button>
                    {historyId ? (
                      <button className="btn btn-primary" onClick={updateOnCookidoo} disabled={sending}>
                        {sending ? <><span className="spinner" /> Updating…</> : '📲 Update'}
                      </button>
                    ) : (
                      <button className="btn btn-primary" onClick={sendToCookidoo} disabled={sending}>
                        {sending ? <><span className="spinner" /> Sending…</> : '📲 Send'}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ── STEP 2: MANUAL EDIT ── */}
            {step === 2 && recipe && editMode && (
              <div className="screen">
                <h2 className="screen-title">Edit Recipe</h2>
                <p className="screen-hint edit-note">Saving converts steps to plain text — Thermomix parameters are removed.</p>
                <label className="field">
                  <span className="field-label">Title</span>
                  <input className="field-input" value={editForm.title} onChange={e => setEditForm(f => ({ ...f, title: e.target.value }))} />
                </label>
                <label className="field">
                  <span className="field-label">Description</span>
                  <textarea className="field-input" value={editForm.description} onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))} rows={3} />
                </label>
                <div className="field-row">
                  <label className="field field-half">
                    <span className="field-label">Servings</span>
                    <input className="field-input" type="number" min="1" value={editForm.servings} onChange={e => setEditForm(f => ({ ...f, servings: e.target.value }))} />
                  </label>
                  <label className="field field-half">
                    <span className="field-label">Prep (min)</span>
                    <input className="field-input" type="number" min="0" value={editForm.prepTime} onChange={e => setEditForm(f => ({ ...f, prepTime: e.target.value }))} />
                  </label>
                  <label className="field field-half">
                    <span className="field-label">Total (min)</span>
                    <input className="field-input" type="number" min="0" value={editForm.totalTime} onChange={e => setEditForm(f => ({ ...f, totalTime: e.target.value }))} />
                  </label>
                </div>
                <label className="field">
                  <span className="field-label">Ingredients <span className="field-note">one per line</span></span>
                  <textarea className="field-input field-tall" value={editForm.ingredientsText} onChange={e => setEditForm(f => ({ ...f, ingredientsText: e.target.value }))} rows={8} />
                </label>
                <label className="field">
                  <span className="field-label">Instructions <span className="field-note">one per line</span></span>
                  <textarea className="field-input field-tall" value={editForm.instructionsText} onChange={e => setEditForm(f => ({ ...f, instructionsText: e.target.value }))} rows={10} />
                </label>
                <div className="action-bar">
                  <button className="btn btn-ghost" onClick={() => setEditMode(false)}>Cancel</button>
                  <button className="btn btn-primary" onClick={saveEdit}>Save changes</button>
                </div>
              </div>
            )}

            {/* ── STEP 3 ── */}
            {step === 3 && (
              <div className="screen screen-confirm">
                {result?.success ? (
                  <>
                    <div className="confirm-icon">✅</div>
                    <h2 className="confirm-title">Recipe sent!</h2>
                    <p className="confirm-body"><strong>{recipe?.title}</strong> has been added to your Cookidoo Created Recipes.</p>
                    {result.url && (
                      <a className="btn btn-secondary btn-full" href={result.url} target="_blank" rel="noreferrer">View on Cookidoo →</a>
                    )}
                  </>
                ) : (
                  <>
                    <div className="confirm-icon">❌</div>
                    <h2 className="confirm-title">Something went wrong</h2>
                    <div className="error-box">{error || 'Unknown error'}</div>
                    <button className="btn btn-secondary btn-full" onClick={() => { setStep(2); setError(''); }}>← Back to Recipe</button>
                  </>
                )}
                <button className="btn btn-primary btn-full" onClick={reset}>Generate Another Recipe</button>
              </div>
            )}
          </>
        )}

        {/* ══ MY RECIPES TAB ════════════════════════════════════════════════ */}
        {tab === 'myrecipes' && (
          <div className="screen">
            {historyLoading ? (
              <div className="history-loading">
                <div className="history-loading-spinner" />
                <p>Loading recipes…</p>
              </div>
            ) : historyError ? (
              <div className="error-box">Could not load recipes: {historyError}</div>
            ) : history.length === 0 ? (
              <div className="history-empty">
                <div className="history-empty-icon">🍳</div>
                <p className="history-empty-text">No saved recipes yet.</p>
                <p className="history-empty-hint">Generate a recipe and send it to Cookidoo — it'll appear here for both of you.</p>
              </div>
            ) : (
              <div className="history-list">
                {history.map(entry => (
                  <HistoryCard
                    key={entry.id}
                    entry={entry}
                    onOpen={() => openFromHistory(entry)}
                    onDelete={() => deleteFromHistory(entry.id)}
                  />
                ))}
              </div>
            )}
          </div>
        )}

      </main>

      {/* ── TAB BAR ── */}
      <nav className="tab-bar">
        <button className={`tab-btn${tab === 'generate' ? ' tab-btn-active' : ''}`} onClick={() => setTab('generate')}>
          <span className="tab-icon">✨</span>
          <span className="tab-label">Generate</span>
        </button>
        <button className={`tab-btn${tab === 'myrecipes' ? ' tab-btn-active' : ''}`} onClick={() => setTab('myrecipes')}>
          <span className="tab-icon">📖</span>
          <span className="tab-label">My Recipes</span>
          {history.length > 0 && <span className="tab-badge">{history.length}</span>}
        </button>
      </nav>

      {/* ── TOAST ── */}
      {toast && <div className={`toast toast-${toast.type}`}>{toast.message}</div>}

    </div>
  );
}
