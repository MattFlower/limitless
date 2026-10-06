export const privacyTexts = ["secret-host.example", "privacy-test-credential"].flatMap((value) => {
  const unicode = [...value].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
  const percent = [...value].map((c) => `%${c.charCodeAt(0).toString(16)}`).join("");
  let nested = percent;
  for (let i = 0; i < 6; i++) nested = encodeURIComponent(nested);
  return [
    value,
    [...value].map((c, i) => (i % 2 ? c.toUpperCase() : c)).join(""),
    unicode,
    percent,
    encodeURIComponent(percent),
    percent.replaceAll("%", "\\u0025"),
    encodeURIComponent(unicode),
    nested,
  ];
});
