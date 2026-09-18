export interface BrowserLocator {
  count(): Promise<number>;
  nth(index: number): BrowserLocator;
  first(): BrowserLocator;
  isVisible(): Promise<boolean>;
  fill(value: string): Promise<void>;
  click(options?: { timeout?: number }): Promise<void>;
  dispatchEvent(type: string): Promise<void>;
  getAttribute(name: string): Promise<string | null>;
  innerText(): Promise<string>;
  inputValue(): Promise<string>;
  isChecked(): Promise<boolean>;
}

export interface BrowserPage {
  goto(
    url: string,
    options?: {
      waitUntil?: "load" | "domcontentloaded" | "networkidle";
      timeout?: number;
    },
  ): Promise<unknown>;
  url(): string;
  locator(selector: string): BrowserLocator;
  waitForLoadState(
    state?: "load" | "domcontentloaded" | "networkidle",
    options?: { timeout?: number },
  ): Promise<void>;
  waitForTimeout(timeout: number): Promise<void>;
}
