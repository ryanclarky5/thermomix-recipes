import { db, DB_ENABLED } from './firebase';
import {
  collection, getDocs, doc, setDoc, deleteDoc, updateDoc, arrayUnion, query, orderBy,
} from 'firebase/firestore';

const COL = 'recipes';

export { DB_ENABLED };

export async function fetchRecipes() {
  if (!DB_ENABLED) return [];
  const q = query(collection(db, COL), orderBy('createdAt', 'desc'));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ ...d.data(), id: d.id }));
}

export async function upsertRecipe(recipe) {
  if (!DB_ENABLED) return recipe.id;
  const id = recipe.id || Date.now().toString();
  await setDoc(doc(db, COL, id), { ...recipe, id });
  return id;
}

export async function removeRecipe(id) {
  if (!DB_ENABLED) return;
  await deleteDoc(doc(db, COL, id));
}

export async function addComment(recipeId, comment) {
  if (!DB_ENABLED) return;
  await updateDoc(doc(db, COL, recipeId), { comments: arrayUnion(comment) });
}
