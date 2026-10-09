import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "reference/**", "out/**", "assets/**", ".venv/**"] },
  ...tseslint.configs.strict,
  {
    rules: {
      // Hot numeric loops index typed arrays whose bounds are known by construction.
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
);
