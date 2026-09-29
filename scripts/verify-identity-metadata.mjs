import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const failures = [];

function requireText(file, expected) {
  const content = read(file);
  for (const value of expected) {
    if (!content.includes(value)) failures.push(`${file}: required identity metadata is missing: ${value}`);
  }
}

requireText("Directory.Build.props", [
  '<AssemblyMetadata Include="Developer" Value="김린" />',
  '<AssemblyMetadata Include="DeveloperEmail" Value="doltongs@naver.com" />',
  '<AssemblyMetadata Include="Publisher" Value="김린" />',
  '<AssemblyMetadata Include="CopyrightOwner" Value="김린" />',
  '<AssemblyMetadata Include="CopyrightYear" Value="2026" />',
]);

for (const file of ["agent/Funnet.Gwanak.Agent.csproj", "installer/Funnet.Gwanak.Agent.Installer.csproj"]) {
  const content = read(file);
  if (!content.includes("<Company>&#x200B;</Company>")) failures.push(`${file}: external publisher field must remain visually blank.`);
  if (/<Copyright>[^<]+<\/Copyright>/.test(content)) failures.push(`${file}: visible copyright field must remain empty.`);
}

const packageJson = JSON.parse(read("package.json"));
if (packageJson.author !== "김린 <doltongs@naver.com>") failures.push("package.json: internal author metadata changed.");
if (JSON.stringify(packageJson.contributors) !== JSON.stringify(["김린 <doltongs@naver.com>"])) failures.push("package.json: internal contributor metadata changed.");

if (failures.length) {
  console.error("Identity metadata protection failed:\n" + failures.map((item) => `- ${item}`).join("\n"));
  process.exit(1);
}

console.log("Identity metadata is intact.");
