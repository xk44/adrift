// ESLint 9+ flat config for Adrift
//
// To activate, install the required packages:
//   npm install -D eslint @eslint/js typescript-eslint eslint-plugin-react-hooks
//
// Then run: npx eslint .

/** @type {import("eslint").Linter.Config[]} */
export default [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "comfy_nodes/**",
      "public/workflows/**",
      "*.tsbuildinfo",
    ],
  },
  // Uncomment after installing packages:
  // ...(await import("@eslint/js")).default.configs.recommended,
  // ...(await import("typescript-eslint")).default.configs.recommended,
];
