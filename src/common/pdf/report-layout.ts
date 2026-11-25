// pdfmake uses export = and this project does not enable esModuleInterop.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import PdfPrinter = require("pdfmake");
import type { Content, TDocumentDefinitions } from "pdfmake/interfaces";

interface ReportHeader {
  name: string;
  document: string | null;
  timezone: string;
  logo?: string | null;
}

export function reportHeader(
  header: ReportHeader,
  title: string,
  period: string,
  issuer: string,
  generatedAt: Date,
): Content[] {
  const logo: Content[] = header.logo
    ? [{ image: header.logo, fit: [114, 33], alignment: "center", margin: [0, 0, 0, 8] }]
    : [];
  return [
    ...logo,
    { text: header.name, style: "church" },
    ...(header.document ? [{ text: `Documento: ${header.document}`, alignment: "center" as const }] : []),
    { text: title, style: "title" },
    {
      columns: [
        { width: "*", text: `Período: ${period}`, bold: true },
        {
          width: "auto",
          text: `Emitido por: ${issuer}, em ${new Intl.DateTimeFormat("pt-BR", {
            timeZone: header.timezone,
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
          }).format(generatedAt)}`,
          alignment: "right",
          fontSize: 8,
          noWrap: true,
        },
      ],
      margin: [0, 0, 0, 12],
    },
  ];
}

interface SummarySection {
  title: string;
  entries: { label: string; value: string }[];
}

export function reportSummary(sections: SummarySection[]): Content {
  return {
    table: {
      widths: sections.map(() => "*"),
      body: [sections.map((section) => ({
        fillColor: "#eeeeee",
        stack: [
          { text: section.title, bold: true, margin: [0, 0, 0, 3] },
          ...(section.entries.length ? [{
            table: {
              widths: ["*", "auto"],
              body: section.entries.map(({ label, value }) => [
                { text: label, margin: [0, 2, 0, 2] }, { text: value, alignment: "right" as const, noWrap: true, margin: [0, 2, 0, 2] },
              ]),
            },
            layout: {
              defaultBorder: false,
              paddingLeft: () => 0,
              paddingRight: () => 0,
              paddingTop: () => 2,
              paddingBottom: () => 2,
            },
          }] : []),
        ],
      }))],
    },
    layout: {
      hLineWidth: () => 0.8,
      vLineWidth: (index) => index === 0 || index === sections.length ? 0.8 : 0,
      paddingLeft: () => 6,
      paddingRight: () => 6,
      paddingTop: () => 6,
      paddingBottom: () => 6,
    },
  };
}

export function reportSignatures(signatureRows: string[][]): Content[] {
  const columnCount = Math.max(...signatureRows.map((row) => row.length), 0);
  return signatureRows.map((labels, index) => ({
    columns: Array.from({ length: columnCount }, (_, column) => labels[column] ? ({
      width: "*",
      margin: [10, 0, 10, 0],
      table: {
        widths: ["*"],
        body: [
          [{ text: "", border: [false, false, false, true] }],
          [{ text: labels[column], alignment: "center", border: [false, false, false, false] }],
        ],
      },
      layout: { defaultBorder: false },
    }) : ({ width: "*", text: "" })),
    columnGap: 10,
    margin: [0, index === 0 ? 32 : 30, 0, 0],
    unbreakable: true,
  }));
}

export function reportLayout(content: Content[]): TDocumentDefinitions {
  return {
    pageSize: "A4",
    pageMargins: [40, 35, 40, 20],
    defaultStyle: { font: "Helvetica", fontSize: 9 },
    styles: {
      church: { fontSize: 14, bold: true, alignment: "center" },
      title: { fontSize: 13, bold: true, alignment: "center", margin: [0, 6, 0, 12] },
      section: { fontSize: 11, bold: true, margin: [0, 10, 0, 5] },
    },
    content,
  };
}

export function renderReport(definition: TDocumentDefinitions): Promise<Buffer> {
  const printer = new PdfPrinter({
    Helvetica: {
      normal: "Helvetica", bold: "Helvetica-Bold",
      italics: "Helvetica-Oblique", bolditalics: "Helvetica-BoldOblique",
    },
  });
  const document = printer.createPdfKitDocument(definition);
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.on("error", reject);
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.end();
  });
}
