declare module "qrcode-terminal" {
  interface QrcodeTerminal {
    generate(
      input: string,
      options: { small?: boolean },
      callback: (output: string) => void,
    ): void;
    setErrorLevel(level: "L" | "M" | "Q" | "H"): void;
  }
  const qrcode: QrcodeTerminal;
  export default qrcode;
}
