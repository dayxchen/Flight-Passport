import { supabase } from "./supabase.js";

const COLUMNS = {
  id: "id",
  savedAt: "saved_at",
  flightDate: "flight_date",
  airlineName: "airline_name",
  flightNumber: "flight_number",
  departureAirport: "departure_airport",
  departureIata: "departure_iata",
  departureIcao: "departure_icao",
  arrivalAirport: "arrival_airport",
  arrivalIata: "arrival_iata",
  arrivalIcao: "arrival_icao",
  scheduledDeparture: "scheduled_departure",
  actualDeparture: "actual_departure",
  scheduledArrival: "scheduled_arrival",
  actualArrival: "actual_arrival",
  status: "status",
  source: "source",
  aircraftRegistration: "aircraft_registration",
  aircraftType: "aircraft_type",
  aircraftIcao24: "aircraft_icao24",
};

const TIME_FIELDS = new Set([
  "savedAt",
  "scheduledDeparture",
  "actualDeparture",
  "scheduledArrival",
  "actualArrival",
]);

function toRow(record) {
  const row = {};
  for (const [field, column] of Object.entries(COLUMNS)) {
    // id and saved_at are assigned by the database.
    if (field === "id" || field === "savedAt") continue;
    const value = record[field];
    if (value === undefined) continue;
    row[column] = TIME_FIELDS.has(field) && value === "" ? null : value;
  }
  return row;
}

function fromRow(row) {
  const record = {};
  for (const [field, column] of Object.entries(COLUMNS)) {
    const value = row[column];
    record[field] = value ?? (TIME_FIELDS.has(field) ? null : "");
  }
  return record;
}

export async function getAllFlights() {
  const { data, error } = await supabase
    .from("flights")
    .select("*")
    .order("flight_date", { ascending: false })
    .order("saved_at", { ascending: false });
  if (error) throw error;
  return data.map(fromRow);
}

export async function saveFlight(record) {
  const { error } = await supabase.from("flights").insert(toRow(record));
  if (error) throw error;
}

export async function deleteFlight(id) {
  const { error } = await supabase.from("flights").delete().eq("id", id);
  if (error) throw error;
}
