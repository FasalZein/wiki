import { mutationOptions } from "./scripts/mutation-file.mjs";

export default mutationOptions(process.env.WIKI_MUTATION_TARGET, process.env);
