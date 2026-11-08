import { randomInt } from "node:crypto";
/** How long a generated pairing code stays valid for confirmation. */
export const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
// Excludes visually ambiguous characters (0/O, 1/I/L) so a player reading
// the code aloud or typing it into a FiveM chat box doesn't misenter it.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
/** Generates a fresh 6-char uppercase alphanumeric pairing code. */
export function generateCode() {
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) {
        code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    }
    return code;
}
