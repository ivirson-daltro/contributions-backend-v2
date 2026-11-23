export interface SignaturesConfig {
  rows: string[][];
}

export const defaultSignaturesConfig: SignaturesConfig = {
  rows: [
    ["1º Tesoureiro(a)", "2º Tesoureiro(a)"],
    ["Conselho Fiscal 1", "Conselho Fiscal 2", "Conselho Fiscal 3"],
    ["Conselho Fiscal 4", "Conselho Fiscal 5"],
  ],
};

export const contributionsReportSignaturesConfig: SignaturesConfig = {
  rows: [
    ["1º Tesoureiro(a)", "2º Tesoureiro(a)"],
    ["Conselho Fiscal 1", "Conselho Fiscal 2", "Conselho Fiscal 3"],
  ],
};
