import { defineConfig } from "vitest/config";
import {
  vitestSetupFilePath,
  getClarinetVitestsArgv,
} from "@stacks/clarinet-sdk/vitest";

// `vitest-environment-clarinet` boots the clarinet-sdk and exposes `simnet`
// globally to every test file. `vitestSetupFilePath` adds the before/after
// hooks that build the simnet and collect cost/coverage reports, plus the
// Clarity matchers (`toBeOk`, `toBeUint`, ...) the tests rely on.
//
//   vitest run -- --costs      # cost report, see README's cost table
//   vitest run -- --coverage   # lcov coverage
export default defineConfig({
  test: {
    environment: "clarinet",
    pool: "forks",
    // clarinet resets the simnet between tests, so vitest isolation is waste
    isolate: false,
    maxWorkers: 1,
    setupFiles: [vitestSetupFilePath],
    environmentOptions: {
      clarinet: {
        ...getClarinetVitestsArgv(),
      },
    },
  },
});
