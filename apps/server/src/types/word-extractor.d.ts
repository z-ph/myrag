/** word-extractor 无官方类型，最小声明（仅用到的 API） */
declare module 'word-extractor' {
  interface WordDocument {
    getBody(): string;
  }
  class WordExtractor {
    extract(buffer: Uint8Array): Promise<WordDocument>;
  }
  export default WordExtractor;
}
