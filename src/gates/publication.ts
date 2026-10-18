import { decodeHTML } from "entities";
import { checkPrivateText, type PrivateStrings } from "./private.ts";

/** Check both the outgoing Markdown and the text exposed by HTML character references. */
export function checkPublicationText(text: string, location: string, entries: PrivateStrings): void {
  checkPrivateText(text, location, entries);
  checkPrivateText(decodeHTML(text).replace(/\s+/g, " "), location, entries);
}
