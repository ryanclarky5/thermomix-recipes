export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { recipe } = req.body || {};
  if (!recipe || !recipe.title) {
    return res.status(400).json({ error: 'Recipe is required' });
  }

  const token = process.env.COOKIDOO_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'COOKIDOO_TOKEN is not configured' });
  }

  const locale = process.env.COOKIDOO_LOCALE || 'ch-de';
  const baseUrl = (process.env.COOKIDOO_BASE_URL || 'https://cookidoo.ch').replace(/\/$/, '');
  const endpoint = `${baseUrl}/created-recipes/${locale}`;

  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Cookie': `_oauth2_proxy=${token}`,
    'User-Agent': 'Mozilla/5.0',
  };

  // Step 1: Create the recipe (POST with just the name) — returns a recipe ID
  let recipeId;
  try {
    const createRes = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ recipeName: recipe.title }),
    });

    const createText = await createRes.text();
    if (!createRes.ok) {
      return res.status(createRes.status).json({
        error: `Cookidoo create failed (${createRes.status}): ${createText}`,
      });
    }

    let createData;
    try {
      createData = JSON.parse(createText);
    } catch {
      return res.status(500).json({ error: 'Unexpected response from Cookidoo', raw: createText });
    }

    recipeId = createData.recipeId || createData.id || createData.recipe_id;
    if (!recipeId) {
      return res.status(500).json({ error: 'No recipe ID in Cookidoo response', raw: createData });
    }
  } catch (e) {
    return res.status(500).json({ error: `Network error on create: ${e.message}` });
  }

  // Brief pause — Cookidoo needs a moment before accepting a PATCH
  await new Promise(r => setTimeout(r, 1500));

  // Step 2: PATCH the full recipe details
  try {
    const patchRes = await fetch(`${endpoint}/${recipeId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        description: recipe.description || '',
        yield: {
          value: Number(recipe.servings) || 4,
          unitText: 'portion',
        },
        prepTime: Number(recipe.prepTime) || 0,
        totalTime: Number(recipe.totalTime) || 0,
        tools: ['TM6'],
        ingredients: recipe.ingredients || [],
        instructions: recipe.instructions || [],
      }),
    });

    const patchText = await patchRes.text();
    if (!patchRes.ok) {
      return res.status(patchRes.status).json({
        error: `Cookidoo update failed (${patchRes.status}): ${patchText}`,
        recipeId,
      });
    }

    return res.status(200).json({
      success: true,
      recipeId,
      url: `${baseUrl}/created-recipes/${locale}/${recipeId}`,
    });
  } catch (e) {
    return res.status(500).json({ error: `Network error on update: ${e.message}`, recipeId });
  }
}
