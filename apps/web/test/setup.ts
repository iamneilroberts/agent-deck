import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// `globals: false` in vite.config.ts means React Testing Library's auto-cleanup (which relies
// on a global `afterEach`) never registers itself — do it explicitly so each test starts with
// an empty DOM.
afterEach(cleanup);
