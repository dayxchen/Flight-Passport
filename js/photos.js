import { supabase } from "./supabase.js";
import { getSession } from "./auth.js";

export const PHOTO_BUCKET = "flight-photos";
export const MAX_PHOTOS_PER_FLIGHT = 20;
export const MAX_INPUT_BYTES = 25 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const SIGNED_URL_TTL = 3600;

function requireUserId() {
  const id = getSession()?.user?.id;
  if (!id) throw new Error("You're signed out. Sign in again to manage photos.");
  return id;
}

function flightPrefix(flightId) {
  return `${requireUserId()}/${encodeURIComponent(String(flightId))}`;
}

// list() returns pseudo-folder rows (id: null) and can include the dashboard's
// own .emptyFolderPlaceholder object — neither is a real photo.
function isRealObject(item) {
  return Boolean(item.id) && !item.name.startsWith(".");
}

export async function listFlightPhotos(flightId) {
  const prefix = flightPrefix(flightId);
  const { data, error } = await supabase.storage
    .from(PHOTO_BUCKET)
    .list(prefix, { limit: 100, sortBy: { column: "name", order: "asc" } });
  if (error) throw error;

  const items = (data || []).filter(isRealObject);
  if (items.length === 0) return [];

  const paths = items.map((item) => `${prefix}/${item.name}`);
  const { data: signed, error: signError } = await supabase.storage
    .from(PHOTO_BUCKET)
    .createSignedUrls(paths, SIGNED_URL_TTL);
  if (signError) throw signError;

  // createSignedUrls reports a failed signature per-item, not on the
  // top-level error, so a single bad object shouldn't fail the whole grid.
  const urlByPath = new Map();
  (signed || []).forEach((entry) => {
    if (!entry.error && entry.signedUrl) urlByPath.set(entry.path, entry.signedUrl);
  });

  return items.map((item, i) => ({
    path: paths[i],
    name: item.name,
    size: item.metadata?.size ?? 0,
    createdAt: item.created_at || null,
    url: urlByPath.get(paths[i]) || null,
  }));
}

export async function uploadFlightPhoto(flightId, blob) {
  const rand = Math.random().toString(36).slice(2, 8);
  const path = `${flightPrefix(flightId)}/${Date.now()}-${rand}.jpg`;
  const { error } = await supabase.storage
    .from(PHOTO_BUCKET)
    .upload(path, blob, { contentType: "image/jpeg", cacheControl: "3600", upsert: false });
  if (error) throw error;
  return { path };
}

export async function signPhotoUrl(path, ttl = SIGNED_URL_TTL) {
  const { data, error } = await supabase.storage.from(PHOTO_BUCKET).createSignedUrl(path, ttl);
  if (error) throw error;
  return data.signedUrl;
}

export async function deleteFlightPhoto(path) {
  const { error } = await supabase.storage.from(PHOTO_BUCKET).remove([path]);
  if (error) throw error;
}

export async function deleteAllFlightPhotos(flightId) {
  const prefix = flightPrefix(flightId);
  const { data, error } = await supabase.storage.from(PHOTO_BUCKET).list(prefix, { limit: 100 });
  if (error) throw error;

  const paths = (data || []).filter(isRealObject).map((item) => `${prefix}/${item.name}`);
  if (paths.length === 0) return 0;

  const { error: removeError } = await supabase.storage.from(PHOTO_BUCKET).remove(paths);
  if (removeError) throw removeError;
  return paths.length;
}
