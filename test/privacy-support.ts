export const privacyTexts = ["secret-host.example", "privacy-test-credential"].flatMap((value) => [
  value,
  [...value].map((c, i) => (i % 2 ? c.toUpperCase() : c)).join(""),
  [...value].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""),
  [...value].map((c) => `%${c.charCodeAt(0).toString(16)}`).join(""),
]);
