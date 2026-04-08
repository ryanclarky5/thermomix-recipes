export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { description, images } = req.body || {};
  const hasText = description?.trim();
  const hasImages = Array.isArray(images) && images.length > 0;

  if (!hasText && !hasImages) return res.status(400).json({ error: 'Provide a description or photos' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  let textContent;
  if (hasText && hasImages) {
    textContent = `Based on these photos and the note "${hasText}", suggest 5 different Thermomix TM6 recipe ideas using the visible ingredients.`;
  } else if (hasImages) {
    textContent = `Based on the ingredients visible in these photos, suggest 5 different Thermomix TM6 recipe ideas.`;
  } else {
    textContent = `Based on these available ingredients or this description: "${hasText}", suggest 5 different Thermomix TM6 recipe ideas.`;
  }

  textContent += `

Make them genuinely varied — different cuisines, meal types, or cooking styles.
Return ONLY a JSON array with exactly 5 items — no markdown, no explanation:
[
  {
    "title": "Recipe Name",
    "description": "One appetising sentence about this dish.",
    "tags": ["quick", "vegetarian"]
  }
]`;

  const content = [];
  if (hasImages) {
    for (const img of images) {
      content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType || 'image/jpeg', data: img.base64 } });
    }
  }
  content.push({ type: 'text', text: textContent });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1024, messages: [{ role: 'user', content }] }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: `Claude API error: ${err}` });
    }

    const data = await response.json();
    let text = data.content?.[0]?.text || '';
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) text = fenceMatch[1];

    let suggestions;
    try { suggestions = JSON.parse(text.trim()); }
    catch { return res.status(500).json({ error: 'Failed to parse suggestions from Claude', raw: text }); }

    if (!Array.isArray(suggestions)) return res.status(500).json({ error: 'Expected array of suggestions' });

    return res.status(200).json(suggestions.slice(0, 5));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
