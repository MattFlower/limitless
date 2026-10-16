import { gitBackend } from "../src/git/confinement.ts";

export const fakeGitConfinement = { wrap: async (cmd: string[]) => cmd };
gitBackend.default = fakeGitConfinement;
