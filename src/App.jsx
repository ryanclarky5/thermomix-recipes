import { useState } from 'react';
import './App.css';

export default function App() {
  const [step, setStep] = useState(1);
  const [prompt, setPrompt] = useState('');
  const [recipe, setRecipe] = useState(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [editMode, setEditMode] = useState(false);
  const [editForm, setEditForm] = useState({});
  const [result, setResult] = useState(null);

  async function generate() {
    if (!prompt.trim() || loading) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/generate-recipe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: prompt }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Generation failed');
      setRecipe(data);
      setEditMode(false);
      setStep(2);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

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
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .map(text => ({ text })),
      instructions: editForm.instructionsText
        .split('\n')
        .map(l => l.replace(/^\d+\.\s*/, '').trim())
        .filter(Boolean)
        .map(text => ({ text })),
    });
    setEditMode(false);
  }

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
      setResult(data);
      setStep(3);
    } catch (e) {
      setError(e.message);
    } finally {
      setSending(false);
    }
  }

  function reset() {
    setStep(1);
    setPrompt('');
    setRecipe(null);
    setResult(null);
    setError('');
    setEditMode(false);
  }

  return (
    <div className="app">
      <header className="app-header">
        <span className="header-logo">🍲</span>
        <div>
          <h1 className="header-title">Recipe Generator</h1>
          <p className="header-sub">Thermomix · Cookidoo</p>
        </div>
      </header>

      <div className="steps-bar">
        {['Generate', 'Review', 'Done'].map((label, i) => (
          <div key={i} className={`step-item ${step === i + 1 ? 'current' : ''} ${step > i + 1 ? 'past' : ''}`}>
            <div className="step-circle">{step > i + 1 ? '✓' : i + 1}</div>
            <span className="step-label">{label}</span>
          </div>
        ))}
        <div className="steps-track">
          <div className="steps-fill" style={{ width: `${(step - 1) * 50}%` }} />
        </div>
      </div>

      <main className="main">

        {/* ─── STEP 1: GENERATE ─── */}
        {step === 1 && (
          <div className="screen">
            <h2 className="screen-title">What would you like to make?</h2>
            <p className="screen-hint">
              Describe a dish in plain language — as simple or detailed as you like.
            </p>

            <textarea
              className="prompt-textarea"
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) generate(); }}
              placeholder="e.g. creamy mushroom risotto for 4 people&#10;e.g. quick weeknight chicken tikka masala&#10;e.g. vegan lentil soup, warming and hearty"
              rows={5}
              disabled={loading}
            />

            {error && <div className="error-box">{error}</div>}

            <button
              className="btn btn-primary btn-full"
              onClick={generate}
              disabled={loading || !prompt.trim()}
            >
              {loading
                ? <><span className="spinner" /> Generating recipe…</>
                : '✨ Generate Recipe'}
            </button>
          </div>
        )}

        {/* ─── STEP 2: REVIEW ─── */}
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
              <ol className="instruction-list">
                {recipe.instructions.map((s, i) => (
                  <li key={i} className="instruction-item">
                    <span className="step-num">{i + 1}</span>
                    <span>{s.text}</span>
                  </li>
                ))}
              </ol>
            </div>

            {error && <div className="error-box">{error}</div>}

            <div className="action-bar">
              <button className="btn btn-ghost" onClick={() => { setStep(1); setError(''); }}>
                ← Back
              </button>
              <button className="btn btn-secondary" onClick={startEdit}>
                ✏️ Edit
              </button>
              <button
                className="btn btn-primary"
                onClick={sendToCookidoo}
                disabled={sending}
              >
                {sending
                  ? <><span className="spinner" /> Sending…</>
                  : '📲 Send to Cookidoo'}
              </button>
            </div>
          </div>
        )}

        {/* ─── STEP 2: EDIT MODE ─── */}
        {step === 2 && recipe && editMode && (
          <div className="screen">
            <h2 className="screen-title">Edit Recipe</h2>

            <label className="field">
              <span className="field-label">Title</span>
              <input
                className="field-input"
                value={editForm.title}
                onChange={e => setEditForm(f => ({ ...f, title: e.target.value }))}
              />
            </label>

            <label className="field">
              <span className="field-label">Description</span>
              <textarea
                className="field-input"
                value={editForm.description}
                onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))}
                rows={3}
              />
            </label>

            <div className="field-row">
              <label className="field field-half">
                <span className="field-label">Servings</span>
                <input
                  className="field-input"
                  type="number"
                  min="1"
                  value={editForm.servings}
                  onChange={e => setEditForm(f => ({ ...f, servings: e.target.value }))}
                />
              </label>
              <label className="field field-half">
                <span className="field-label">Prep (min)</span>
                <input
                  className="field-input"
                  type="number"
                  min="0"
                  value={editForm.prepTime}
                  onChange={e => setEditForm(f => ({ ...f, prepTime: e.target.value }))}
                />
              </label>
              <label className="field field-half">
                <span className="field-label">Total (min)</span>
                <input
                  className="field-input"
                  type="number"
                  min="0"
                  value={editForm.totalTime}
                  onChange={e => setEditForm(f => ({ ...f, totalTime: e.target.value }))}
                />
              </label>
            </div>

            <label className="field">
              <span className="field-label">
                Ingredients <span className="field-note">one per line</span>
              </span>
              <textarea
                className="field-input field-tall"
                value={editForm.ingredientsText}
                onChange={e => setEditForm(f => ({ ...f, ingredientsText: e.target.value }))}
                rows={8}
              />
            </label>

            <label className="field">
              <span className="field-label">
                Instructions <span className="field-note">one per line — numbers are stripped on save</span>
              </span>
              <textarea
                className="field-input field-tall"
                value={editForm.instructionsText}
                onChange={e => setEditForm(f => ({ ...f, instructionsText: e.target.value }))}
                rows={10}
              />
            </label>

            <div className="action-bar">
              <button className="btn btn-ghost" onClick={() => setEditMode(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={saveEdit}>
                Save changes
              </button>
            </div>
          </div>
        )}

        {/* ─── STEP 3: CONFIRMATION ─── */}
        {step === 3 && (
          <div className="screen screen-confirm">
            {result?.success ? (
              <>
                <div className="confirm-icon">✅</div>
                <h2 className="confirm-title">Recipe sent!</h2>
                <p className="confirm-body">
                  <strong>{recipe?.title}</strong> has been added to your Cookidoo Created Recipes.
                </p>
                {result.url && (
                  <a
                    className="btn btn-secondary btn-full"
                    href={result.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View on Cookidoo →
                  </a>
                )}
              </>
            ) : (
              <>
                <div className="confirm-icon">❌</div>
                <h2 className="confirm-title">Something went wrong</h2>
                <div className="error-box">{error || 'Unknown error'}</div>
                <button className="btn btn-secondary btn-full" onClick={() => { setStep(2); setError(''); }}>
                  ← Back to Recipe
                </button>
              </>
            )}
            <button className="btn btn-primary btn-full" onClick={reset}>
              Generate Another Recipe
            </button>
          </div>
        )}

      </main>
    </div>
  );
}
