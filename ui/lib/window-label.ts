export function windowLabel(key: string): string {
  if (key === "five_hour") return "5h";
  if (key === "seven_day") return "7d";
  if (key.startsWith("five_hour_")) return `5h ${key.slice("five_hour_".length).replaceAll("_", " ")}`;
  if (key.startsWith("seven_day_")) return `7d ${key.slice("seven_day_".length).replaceAll("_", " ")}`;
  return key.replaceAll("_", " ");
}
