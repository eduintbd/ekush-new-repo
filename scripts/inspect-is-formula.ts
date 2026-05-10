// Read the actual formulas on IS!H24, BS!H38 (Provision for Tax),
// and IS!H25 (Net Profit) so we can see how the workbook computes them.
import ExcelJS from "exceljs";
import path from "node:path";

async function main() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.resolve("docs/F.S March 2026.xlsx"));

  const cellsToInspect = [
    ["IS.", "H24"],
    ["IS.", "H25"],
    ["IS.", "H27"],
    ["IS.", "H30"],
    ["BS.", "H38"],
    ["BS.", "H29"],
    ["BS.", "H31"],
    ["Notes. (2)", "F12"],
  ] as const;

  for (const [sheetName, addr] of cellsToInspect) {
    const sheet = wb.getWorksheet(sheetName);
    if (!sheet) {
      console.log(`${sheetName}!${addr}: sheet not found`);
      continue;
    }
    const cell = sheet.getCell(addr);
    console.log(
      `${sheetName}!${addr}:`,
      "value =",
      JSON.stringify(cell.value),
      "| formula =",
      cell.formula ?? "(none)",
      "| result =",
      JSON.stringify(cell.result),
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
