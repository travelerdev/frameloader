declare module "app-info-parser" {
  class AppInfoParser {
    constructor(file: string);
    parse(): Promise<Record<string, unknown>>;
  }
  export = AppInfoParser;
}
