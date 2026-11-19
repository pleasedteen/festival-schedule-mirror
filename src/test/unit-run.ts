import { runUnitChecks } from './unit';

let passed = 0;
let failed = 0;

runUnitChecks((name, condition, detail) => {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? `  ${detail}` : ''}`);
  }
});

console.log(`\n单元检查：${passed} 项通过，${failed} 项失败`);
if (failed > 0) process.exitCode = 1;
