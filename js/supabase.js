// Find these in the Supabase dashboard: Settings -> API
const SUPABASE_URL = "https://ilmmxdmupjgzvfsoifsq.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_mObSo7cVSJMtEl2RQKEhDw_ivvKX663";

export const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
