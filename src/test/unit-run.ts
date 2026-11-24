import { runUnitChecks, runRateLimitGateChecks } from './unit';

let passed = 0;
let failed = 0;

const check = (name: string, condition: boolean, detail?: string): void => {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? `  ${detail}` : ''}`);
  }
};

async function main(): Promise<void> {
  runUnitChecks(check);
  await runRateLimitGateChecks(check);
  console.log(`\n单元检查：${passed} 项通过，${failed} 项失败`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
