
import supabase from "../supabaseClient.js";

export async function getTerminals() {
  const { data, error } = await supabase
    .from("public.terminal")   // your table name
    .select("terminal_name, long, lat"); // adjust fields

  if (error) {
    console.error("Error fetching terminals:", error);
    return [];
  }

  return data;
}
