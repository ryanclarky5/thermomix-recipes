import { useState, useRef, useCallback, useEffect } from 'react';
import './App.css';
import { fetchRecipes, upsertRecipe, removeRecipe, addComment as addCommentDb, DB_ENABLED } from './db';

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

// ─── Servings scaling ────────────────────────────────────────────────────────

function scaleNumber(val, factor) {
  const result = val * factor;
  if (result === 0) return '0';
  const intPart = Math.floor(result);
  const frac = result - intPart;
  const niceFracs = [[0.25,'¼'],[0.33,'⅓'],[0.5,'½'],[0.67,'⅔'],[0.75,'¾']];
  for (const [n, sym] of niceFracs) {
    if (Math.abs(frac - n) < 0.07) return intPart > 0 ? `${intPart} ${sym}` : sym;
  }
  if (Math.abs(result - Math.round(result)) < 0.07) return String(Math.round(result));
  return parseFloat(result.toFixed(1)).toString();
}

function scaleIngredientText(text, factor) {
  if (Math.abs(factor - 1) < 0.001) return text;
  let done = false;
  return text.replace(/(\d+(?:\.\d+)?)(?:\/(\d+))?/, (match, whole, denom) => {
    if (done) return match;
    done = true;
    const val = denom ? parseFloat(whole) / parseFloat(denom) : parseFloat(whole);
    return scaleNumber(val, factor);
  });
}

function formatShoppingList(r) {
  return `🛒 ${r.title} (serves ${r.servings})\n\n` +
    r.ingredients.map(i => `• ${i.text}`).join('\n');
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

function StarRating({ value, onChange, readOnly = false }) {
  return (
    <div className="star-rating">
      {[1,2,3,4,5].map(n => (
        <button key={n} type="button" className={`star${n <= value ? ' star-filled' : ''}`}
          onClick={() => !readOnly && onChange(n)} disabled={readOnly} aria-label={`${n} star`}>
          {n <= value ? '★' : '☆'}
        </button>
      ))}
    </div>
  );
}

function HistoryCard({ entry, onOpen, onDuplicate, onDelete }) {
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
      <div className="history-card-actions">
        <button className="history-card-btn" onClick={e => { e.stopPropagation(); onDuplicate(); }} aria-label="Duplicate recipe" title="Duplicate">📋</button>
        <button className="history-card-btn history-card-btn-delete" onClick={e => { e.stopPropagation(); onDelete(); }} aria-label="Delete recipe" title="Delete">🗑</button>
      </div>
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

  // Suggestions
  const [suggestMode, setSuggestMode] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [suggesting, setSuggesting] = useState(false);

  // Nutrition + wine
  const [nutrition, setNutrition] = useState(null);
  const [nutritionLoading, setNutritionLoading] = useState(false);
  const [winePairing, setWinePairing] = useState(null);
  const [winePairingLoading, setWinePairingLoading] = useState(false);
  // ingredient substitution: { [index]: { loading, substitute, tip } }
  const [ingSubs, setIngSubs] = useState({});

  // Comments
  const [commentAuthor, setCommentAuthor] = useState(() => localStorage.getItem('commentAuthor') || '');
  const [commentRating, setCommentRating] = useState(0);
  const [commentText, setCommentText] = useState('');
  const [commentSaving, setCommentSaving] = useState(false);

  // Meal plan
  const [mealPlan, setMealPlan] = useState(new Set());
  const [mealPlanList, setMealPlanList] = useState(null);
  const [mealPlanLoading, setMealPlanLoading] = useState(false);
  const [mealPlanCopied, setMealPlanCopied] = useState(false);

  // Servings scaler
  const [baseRecipe, setBaseRecipe] = useState(null);
  const [scaledServings, setScaledServings] = useState(null);

  // Shopping list
  const [shoppingListOpen, setShoppingListOpen] = useState(false);
  const [copied, setCopied] = useState(false);

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

  // ── Apply a recipe (sets base for scaling, clears AI extras) ────────────
  function applyRecipe(data) {
    setRecipe(data);
    setBaseRecipe(data);
    setScaledServings(data.servings);
    setNutrition(null);
    setWinePairing(null);
    setIngSubs({});
  }

  // ── Servings scaler ───────────────────────────────────────────────────────
  function adjustServings(delta) {
    const newServings = Math.max(1, scaledServings + delta);
    if (newServings === scaledServings) return;
    const factor = newServings / baseRecipe.servings;
    setScaledServings(newServings);
    setRecipe(prev => ({
      ...prev,
      servings: newServings,
      ingredients: baseRecipe.ingredients.map(ing => ({
        ...ing,
        text: scaleIngredientText(ing.text, factor),
      })),
    }));
  }

  // ── Shopping list ─────────────────────────────────────────────────────────
  async function openShoppingList() {
    const text = formatShoppingList(recipe);
    if (navigator.share) {
      try {
        await navigator.share({ title: `${recipe.title} — Shopping List`, text });
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }
    setShoppingListOpen(true);
  }

  async function copyShoppingList() {
    await navigator.clipboard.writeText(formatShoppingList(recipe));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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

  function duplicateRecipe(entry) {
    applyRecipe({
      title: `${entry.title} (copy)`,
      description: entry.description,
      servings: entry.servings,
      prepTime: entry.prepTime,
      totalTime: entry.totalTime,
      ingredients: entry.ingredients,
      instructions: entry.instructions,
    });
    setHistoryId(null);
    setStep(2);
    setEditMode(false);
    setAiEditMode(false);
    setError('');
    setResult(null);
    setTab('generate');
  }

  async function deleteFromHistory(id) {
    await removeRecipe(id);
    setHistory(prev => prev.filter(e => e.id !== id));
  }

  function openFromHistory(entry) {
    applyRecipe(entry);
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
    setBaseRecipe(null);
    setScaledServings(null);
    setStep(1);
    setEditMode(false);
    setAiEditMode(false);
    setError('');
    setCommentRating(0);
    setCommentText('');
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

  // ── Generate (shared core) ────────────────────────────────────────────────
  async function generateRecipe(description, imgs) {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/generate-recipe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description,
          images: imgs.map(({ base64, mediaType }) => ({ base64, mediaType })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Generation failed');
      applyRecipe(data);
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

  async function generate() {
    if ((!prompt.trim() && images.length === 0) || loading) return;
    await generateRecipe(prompt, images);
  }

  // ── Recipe suggestions ────────────────────────────────────────────────────
  async function getSuggestions() {
    if ((!prompt.trim() && images.length === 0) || suggesting) return;
    setSuggesting(true);
    setSuggestions([]);
    setSuggestMode(false);
    setError('');
    try {
      const res = await fetch('/api/suggest-recipes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: prompt,
          images: images.map(({ base64, mediaType }) => ({ base64, mediaType })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to get suggestions');
      setSuggestions(data);
      setSuggestMode(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setSuggesting(false);
    }
  }

  async function pickSuggestion(s) {
    setPrompt(s.title);
    setSuggestMode(false);
    setSuggestions([]);
    await generateRecipe(s.title, images);
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
    const edited = {
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
    };
    applyRecipe(edited);
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
      applyRecipe(data);
      setAiEditMode(false);
      setAiEditPrompt('');
    } catch (e) {
      setError(e.message);
    } finally {
      setAiEditing(false);
    }
  }

  // ── Nutrition estimate ────────────────────────────────────────────────────
  async function getNutrition() {
    if (nutritionLoading) return;
    setNutritionLoading(true);
    try {
      const res = await fetch('/api/nutrition', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipe }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to estimate nutrition');
      setNutrition(data);
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setNutritionLoading(false);
    }
  }

  // ── Wine pairing ──────────────────────────────────────────────────────────
  async function getWinePairing() {
    if (winePairingLoading) return;
    setWinePairingLoading(true);
    try {
      const res = await fetch('/api/wine-pairing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipe }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to get wine pairing');
      setWinePairing(data);
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setWinePairingLoading(false);
    }
  }

  // ── Ingredient substitution ───────────────────────────────────────────────
  async function suggestSub(index) {
    const ing = recipe.ingredients[index];
    if (!ing) return;
    setIngSubs(s => ({ ...s, [index]: { loading: true } }));
    try {
      const res = await fetch('/api/ingredient-sub', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ingredient: ing.text, recipe }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to get substitution');
      setIngSubs(s => ({ ...s, [index]: { loading: false, substitute: data.substitute, tip: data.tip } }));
    } catch (e) {
      setIngSubs(s => ({ ...s, [index]: { loading: false, error: e.message } }));
    }
  }

  async function applySub(index) {
    const sub = ingSubs[index];
    if (!sub?.substitute) return;
    const original = recipe.ingredients[index]?.text;
    const update = ings => ings.map((ing, i) => i === index ? { ...ing, text: sub.substitute } : ing);
    // Update ingredient immediately so it's visible
    const updatedRecipe = { ...recipe, ingredients: update(recipe.ingredients) };
    setRecipe(updatedRecipe);
    setBaseRecipe(r => ({ ...r, ingredients: update(r.ingredients) }));
    dismissSub(index);
    // Now fix the instructions to match
    showToast('Updating instructions…', 'info');
    try {
      const res = await fetch('/api/edit-recipe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipe: updatedRecipe,
          instruction: `"${original}" has been replaced with "${sub.substitute}". Update the instructions and any step parameters so they correctly reflect this substitution — remove any mention of "${original}" and adjust cooking method, time, or temperature if needed for the substitute.`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update instructions');
      applyRecipe(data);
      showToast('Instructions updated', 'success');
    } catch (e) {
      showToast('Instructions not updated: ' + e.message, 'error');
    }
  }

  function dismissSub(index) {
    setIngSubs(s => { const n = { ...s }; delete n[index]; return n; });
  }

  // ── Comments ──────────────────────────────────────────────────────────────
  async function saveComment() {
    if (!historyId || !commentRating || commentSaving) return;
    setCommentSaving(true);
    const author = commentAuthor.trim() || 'Anonymous';
    localStorage.setItem('commentAuthor', author);
    const comment = {
      id: Date.now().toString(),
      author,
      rating: commentRating,
      text: commentText.trim(),
      createdAt: new Date().toISOString(),
    };
    try {
      await addCommentDb(historyId, comment);
      setHistory(h => h.map(e => e.id === historyId
        ? { ...e, comments: [...(e.comments || []), comment] }
        : e
      ));
      setCommentRating(0);
      setCommentText('');
      showToast('Comment saved ✓');
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setCommentSaving(false);
    }
  }

  // ── Meal planner ──────────────────────────────────────────────────────────
  function toggleMealPlan(id) {
    setMealPlan(prev => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); }
      else if (next.size < 7) { next.add(id); }
      return next;
    });
    setMealPlanList(null);
  }

  async function generateMealPlanList() {
    if (mealPlan.size === 0 || mealPlanLoading) return;
    setMealPlanLoading(true);
    const selected = history.filter(e => mealPlan.has(e.id));
    try {
      const res = await fetch('/api/meal-plan-shopping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipes: selected.map(r => ({ title: r.title, servings: r.servings, ingredients: r.ingredients })) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to generate list');
      setMealPlanList(data);
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setMealPlanLoading(false);
    }
  }

  async function copyMealPlanList() {
    if (!mealPlanList) return;
    const selected = history.filter(e => mealPlan.has(e.id));
    const header = `🗓 Weekly Shopping List\n${selected.map(r => `• ${r.title}`).join('\n')}\n\n`;
    const body = mealPlanList.categories.map(cat =>
      `${cat.name}\n${cat.items.map(i => `• ${i}`).join('\n')}`
    ).join('\n\n');
    const text = header + body + (mealPlanList.note ? `\n\n💡 ${mealPlanList.note}` : '');
    if (navigator.share) {
      try { await navigator.share({ text }); return; } catch {}
    }
    await navigator.clipboard.writeText(text);
    setMealPlanCopied(true);
    setTimeout(() => setMealPlanCopied(false), 2500);
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
    setBaseRecipe(null); setScaledServings(null);
    setSuggestMode(false); setSuggestions([]);
    setNutrition(null); setWinePairing(null);
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

                {suggestMode && suggestions.length > 0 && (
                  <div className="suggestions-panel">
                    <div className="suggestions-header">
                      <span className="suggestions-label">Choose a recipe to generate</span>
                      <button className="suggestions-close" onClick={() => { setSuggestMode(false); setSuggestions([]); }}>×</button>
                    </div>
                    {suggestions.map((s, i) => (
                      <button key={i} className="suggestion-card" onClick={() => pickSuggestion(s)} disabled={loading}>
                        <div className="suggestion-title">{s.title}</div>
                        <div className="suggestion-desc">{s.description}</div>
                        {s.tags?.length > 0 && (
                          <div className="suggestion-tags">
                            {s.tags.map(t => <span key={t} className="suggestion-tag">{t}</span>)}
                          </div>
                        )}
                      </button>
                    ))}
                    <button className="btn btn-ghost" style={{ marginTop: 6 }} onClick={() => { setSuggestMode(false); setSuggestions([]); }}>← Type manually instead</button>
                  </div>
                )}

                <div className="generate-actions">
                  <button className="btn btn-secondary" onClick={getSuggestions} disabled={suggesting || loading || !canGenerate}>
                    {suggesting ? <>⏳ Getting ideas…</> : '💡 Suggest'}
                  </button>
                  <button className="btn btn-primary generate-btn" onClick={generate} disabled={loading || suggesting || !canGenerate}>
                    {loading
                      ? <><span className="spinner" /> {images.length > 0 ? 'Analysing…' : 'Generating…'}</>
                      : '✨ Generate Recipe'}
                  </button>
                </div>
              </div>
            )}

            {/* ── STEP 2: REVIEW ── */}
            {step === 2 && recipe && !editMode && (
              <div className="screen">
                <div className="recipe-card">
                  <h2 className="recipe-title">{recipe.title}</h2>
                  <p className="recipe-desc">{recipe.description}</p>
                  <div className="recipe-meta">
                    <div className="servings-scaler">
                      <button className="scaler-btn" onClick={() => adjustServings(-1)} disabled={(scaledServings ?? recipe.servings) <= 1} aria-label="Fewer servings">−</button>
                      <span className="scaler-value">👤 {scaledServings ?? recipe.servings} {(scaledServings ?? recipe.servings) === 1 ? 'serving' : 'servings'}</span>
                      <button className="scaler-btn" onClick={() => adjustServings(1)} aria-label="More servings">+</button>
                    </div>
                    {recipe.prepTime > 0 && <span>🔪 {Math.round(recipe.prepTime / 60)} min prep</span>}
                    {recipe.totalTime > 0 && <span>⏱ {Math.round(recipe.totalTime / 60)} min total</span>}
                  </div>
                </div>

                <div className="recipe-section">
                  <div className="section-heading-row">
                    <h3 className="section-heading">Ingredients</h3>
                    <button className="section-action-btn" onClick={openShoppingList} type="button">🛒 Shopping list</button>
                  </div>
                  <ul className="ingredient-list">
                    {recipe.ingredients.map((ing, i) => {
                      const sub = ingSubs[i];
                      return (
                        <li key={i} className="ingredient-item">
                          <div className="ingredient-row">
                            <span className="ingredient-text">{ing.text}</span>
                            {!sub && (
                              <button className="ing-sub-btn" onClick={() => suggestSub(i)} title="Suggest alternative" aria-label="Suggest alternative">
                                🔄
                              </button>
                            )}
                          </div>
                          {sub && (
                            <div className="ing-sub-tip">
                              {sub.loading ? (
                                <span className="ing-sub-loading">Finding alternative…</span>
                              ) : sub.error ? (
                                <>
                                  <span className="ing-sub-error">{sub.error}</span>
                                  <button className="ing-sub-dismiss" onClick={() => dismissSub(i)}>Dismiss</button>
                                </>
                              ) : (
                                <>
                                  <div className="ing-sub-content">
                                    <span className="ing-sub-label">Try instead:</span>
                                    <span className="ing-sub-text">{sub.substitute}</span>
                                    <p className="ing-sub-why">{sub.tip}</p>
                                  </div>
                                  <div className="ing-sub-actions">
                                    <button className="ing-sub-apply" onClick={() => applySub(i)}>Use this</button>
                                    <button className="ing-sub-dismiss" onClick={() => dismissSub(i)}>Dismiss</button>
                                  </div>
                                </>
                              )}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>

                <div className="recipe-section">
                  <h3 className="section-heading">Instructions</h3>
                  <div className="step-list">
                    {recipe.instructions.map((s, i) => <StepCard key={i} step={s} index={i} />)}
                  </div>
                </div>

                {/* ── AI Extras: nutrition + wine ── */}
                <div className="ai-extras-row">
                  {!nutrition && (
                    <button className="ai-extra-btn" onClick={getNutrition} disabled={nutritionLoading}>
                      {nutritionLoading ? <>⏳ Estimating…</> : '📊 Nutrition'}
                    </button>
                  )}
                  {!winePairing && (
                    <button className="ai-extra-btn" onClick={getWinePairing} disabled={winePairingLoading}>
                      {winePairingLoading ? <>⏳ Pairing…</> : '🍷 Wine pairing'}
                    </button>
                  )}
                </div>

                {nutrition && (
                  <div className="info-card">
                    <div className="info-card-header">
                      <h3 className="info-card-title">📊 Nutrition <span className="info-card-sub">per serving</span></h3>
                      <button className="info-card-dismiss" onClick={() => setNutrition(null)}>×</button>
                    </div>
                    <div className="macro-grid">
                      <div className="macro-item"><span className="macro-val">{nutrition.perServing.calories}</span><span className="macro-label">kcal</span></div>
                      <div className="macro-item"><span className="macro-val">{nutrition.perServing.protein}g</span><span className="macro-label">Protein</span></div>
                      <div className="macro-item"><span className="macro-val">{nutrition.perServing.carbs}g</span><span className="macro-label">Carbs</span></div>
                      <div className="macro-item"><span className="macro-val">{nutrition.perServing.fat}g</span><span className="macro-label">Fat</span></div>
                      {nutrition.perServing.fibre != null && <div className="macro-item"><span className="macro-val">{nutrition.perServing.fibre}g</span><span className="macro-label">Fibre</span></div>}
                    </div>
                    <p className="info-card-note">{nutrition.disclaimer}</p>
                  </div>
                )}

                {winePairing && (
                  <div className="info-card">
                    <div className="info-card-header">
                      <h3 className="info-card-title">🍷 Wine Pairing</h3>
                      <button className="info-card-dismiss" onClick={() => setWinePairing(null)}>×</button>
                    </div>
                    {winePairing.pairings?.map((p, i) => (
                      <div key={i} className="wine-item">
                        <span className="wine-name">{p.wine}</span>
                        <span className="wine-why">{p.why}</span>
                      </div>
                    ))}
                    {winePairing.note && <p className="info-card-note">{winePairing.note}</p>}
                  </div>
                )}

                {/* ── Comments & Ratings (saved recipes only) ── */}
                {historyId && (() => {
                  const comments = history.find(e => e.id === historyId)?.comments || [];
                  const avgRating = comments.length
                    ? (comments.reduce((s, c) => s + c.rating, 0) / comments.length).toFixed(1)
                    : null;
                  return (
                    <div className="comments-section">
                      <div className="comments-header">
                        <h3 className="section-heading">Reviews</h3>
                        {avgRating && (
                          <span className="comments-avg">
                            <span className="star star-filled">★</span> {avgRating} ({comments.length})
                          </span>
                        )}
                      </div>
                      {comments.length > 0 && (
                        <div className="comment-list">
                          {comments.map(c => (
                            <div key={c.id} className="comment-item">
                              <div className="comment-meta">
                                <span className="comment-author">{c.author}</span>
                                <StarRating value={c.rating} readOnly />
                                <span className="comment-date">{fmtDate(c.createdAt)}</span>
                              </div>
                              {c.text && <p className="comment-text">{c.text}</p>}
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="comment-form">
                        <p className="comment-form-label">Leave a review</p>
                        <input
                          className="field-input comment-author-input"
                          placeholder="Your name"
                          value={commentAuthor}
                          onChange={e => setCommentAuthor(e.target.value)}
                        />
                        <StarRating value={commentRating} onChange={setCommentRating} />
                        <textarea
                          className="field-input comment-text-input"
                          placeholder="Any notes? (optional)"
                          value={commentText}
                          onChange={e => setCommentText(e.target.value)}
                          rows={2}
                        />
                        <button className="btn btn-secondary" onClick={saveComment}
                          disabled={!commentRating || commentSaving}>
                          {commentSaving ? 'Saving…' : 'Save review'}
                        </button>
                      </div>
                    </div>
                  );
                })()}

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
                    onDuplicate={() => duplicateRecipe(entry)}
                    onDelete={() => deleteFromHistory(entry.id)}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* ══ MEAL PLAN TAB ══════════════════════════════════════════════════ */}
        {tab === 'plan' && (
          <div className="screen">
            <h2 className="screen-title">Weekly Meal Plan</h2>
            <p className="screen-hint">Pick up to 7 recipes and get a consolidated shopping list.</p>

            {history.length === 0 ? (
              <div className="history-empty">
                <div className="history-empty-icon">🗓</div>
                <p className="history-empty-text">No saved recipes yet.</p>
                <p className="history-empty-hint">Save some recipes first, then plan your week here.</p>
              </div>
            ) : (
              <>
                <div className="plan-recipe-list">
                  {history.map(entry => {
                    const selected = mealPlan.has(entry.id);
                    const avgRating = entry.comments?.length
                      ? (entry.comments.reduce((s, c) => s + c.rating, 0) / entry.comments.length).toFixed(1)
                      : null;
                    return (
                      <button
                        key={entry.id}
                        className={`plan-recipe-row${selected ? ' plan-recipe-row-selected' : ''}`}
                        onClick={() => toggleMealPlan(entry.id)}
                        type="button"
                      >
                        <span className={`plan-checkbox${selected ? ' plan-checkbox-checked' : ''}`}>
                          {selected ? '✓' : ''}
                        </span>
                        <span className="plan-recipe-info">
                          <span className="plan-recipe-title">{entry.title}</span>
                          <span className="plan-recipe-meta">
                            {entry.servings} servings
                            {avgRating && <> · <span className="star star-filled" style={{fontSize:'12px'}}>★</span> {avgRating}</>}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>

                <div className="plan-actions">
                  {mealPlan.size > 0 && (
                    <span className="plan-count">{mealPlan.size} recipe{mealPlan.size !== 1 ? 's' : ''} selected</span>
                  )}
                  <button className="btn btn-primary" onClick={generateMealPlanList}
                    disabled={mealPlan.size === 0 || mealPlanLoading}>
                    {mealPlanLoading ? <><span className="spinner" /> Building list…</> : '🛒 Generate shopping list'}
                  </button>
                  {mealPlan.size > 0 && (
                    <button className="btn btn-ghost" onClick={() => { setMealPlan(new Set()); setMealPlanList(null); }}>
                      Clear
                    </button>
                  )}
                </div>

                {mealPlanList && (
                  <div className="plan-shopping-list">
                    <div className="plan-list-header">
                      <h3 className="plan-list-title">🛒 Shopping List</h3>
                      <button className="btn btn-secondary btn-sm" onClick={copyMealPlanList}>
                        {mealPlanCopied ? '✓ Copied!' : '📋 Copy / Share'}
                      </button>
                    </div>
                    <p className="plan-list-recipes">
                      {history.filter(e => mealPlan.has(e.id)).map(e => e.title).join(', ')}
                    </p>
                    {mealPlanList.categories.map((cat, i) => (
                      <div key={i} className="plan-category">
                        <h4 className="plan-category-name">{cat.name}</h4>
                        <ul className="plan-items">
                          {cat.items.map((item, j) => (
                            <li key={j} className="plan-item">{item}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                    {mealPlanList.note && (
                      <p className="plan-list-note">💡 {mealPlanList.note}</p>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}

      </main>

      {/* ── SHOPPING LIST MODAL ── */}
      {shoppingListOpen && (
        <div className="modal-overlay" onClick={() => { setShoppingListOpen(false); setCopied(false); }}>
          <div className="modal-sheet" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">🛒 Shopping List</h3>
              <button className="modal-close" onClick={() => { setShoppingListOpen(false); setCopied(false); }}>×</button>
            </div>
            <p className="modal-recipe-name">{recipe?.title} · serves {recipe?.servings}</p>
            <ul className="shopping-items">
              {recipe?.ingredients.map((ing, i) => (
                <li key={i} className="shopping-item">{ing.text}</li>
              ))}
            </ul>
            <div className="modal-actions">
              <button className="btn btn-primary btn-full" onClick={copyShoppingList}>
                {copied ? '✓ Copied!' : '📋 Copy to clipboard'}
              </button>
            </div>
          </div>
        </div>
      )}

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
        <button className={`tab-btn${tab === 'plan' ? ' tab-btn-active' : ''}`} onClick={() => setTab('plan')}>
          <span className="tab-icon">🗓</span>
          <span className="tab-label">Meal Plan</span>
          {mealPlan.size > 0 && <span className="tab-badge">{mealPlan.size}</span>}
        </button>
      </nav>

      {/* ── TOAST ── */}
      {toast && <div className={`toast toast-${toast.type}`}>{toast.message}</div>}

    </div>
  );
}
