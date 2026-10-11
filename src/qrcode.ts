import qrcode from "qrcode-terminal";

export const renderQrcode = (content: string): string => {
  let output = "";
  qrcode.generate(content, { small: true }, (text) => {
    output = text;
  });
  return output;
};
