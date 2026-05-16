import ExcelJS from "exceljs";
import path from "node:path";

async function main() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.resolve("docs/F.S March 2026.xlsx"));
  console.log("=== WORKSHEETS ===");
  wb.eachSheet((sheet) => {
    console.log(`${sheet.name.padEnd(30)} rows=${sheet.rowCount}  cols=${sheet.columnCount}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
