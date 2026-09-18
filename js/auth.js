import { supabase } from "./supabase.js";

let session = null;
const listeners = [];

export function getSession() {
  return session;
}

export function onAuthChange(callback) {
  listeners.push(callback);
}

function notify() {
  listeners.forEach((callback) => callback(session));
}

export async function initAuth() {
  const { data } = await supabase.auth.getSession();
  session = data.session;
  notify();

  supabase.auth.onAuthStateChange((_event, newSession) => {
    session = newSession;
    // Listeners may call Supabase (e.g. loading flights). Doing that inside
    // this callback can deadlock on the client's auth lock, so defer it.
    setTimeout(notify, 0);
  });
}

export async function sendMagicLink(email) {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin + window.location.pathname },
  });
  if (error) throw error;
}

export async function signInWithGoogle() {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin + window.location.pathname },
  });
  if (error) throw error;
}

export async function signOut() {
  await supabase.auth.signOut();
}
