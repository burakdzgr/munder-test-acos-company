// GenericTextIndexer (LIFECYCLE TASK 4): adapter'ı olmayan diller için son
// çare — dosya satırı indekse girer (path/sha/loc/dil), sembol çıkarımı
// yapılmaz. Yeni bir dil ciddiye alınacaksa kendi adapter'ını yazın.
import type { LanguageIndexer } from "./index.js";

export const genericTextIndexer: LanguageIndexer = {
  name: "generic",
  matches: () => true,
  parse: ({ path, sha, content }) => ({
    path,
    sha,
    language: path.split(".").pop() ?? "text",
    loc: content.split("\n").length,
    isTest: /(?:^|\/)tests?\//.test(path),
    symbols: [],
    imports: [],
    calls: [],
    heritage: [],
  }),
};
