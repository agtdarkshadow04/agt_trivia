export const APP_CONFIG = Object.freeze({
  categoriesCsvUrl:
    import.meta.env.VITE_CATEGORIES_CSV_URL || "/data/categories.csv",
  questionsCsvUrl:
    import.meta.env.VITE_QUESTIONS_CSV_URL || "/data/questions.csv",
  logoPath: import.meta.env.VITE_LOGO_PATH || "/logo-placeholder.svg",
});
