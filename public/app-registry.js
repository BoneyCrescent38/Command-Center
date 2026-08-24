import { DashboardModule } from "./modules/dashboard.js";
import { createPlaceholderModule } from "./modules/placeholder.js";
import { SchoolModule } from "./modules/school.js";

export const appRegistry = Object.freeze([
  {
    id: "dashboard",
    label: "Dashboard",
    shortLabel: "DB",
    accent: "cyan",
    module: DashboardModule,
  },
  {
    id: "spotify",
    label: "Spotify",
    shortLabel: "SP",
    accent: "green",
    module: createPlaceholderModule({
      id: "spotify",
      eyebrow: "MEDIA",
      title: "Spotify",
      description: "Musikkstyring kobles inn som en egen modul uten å endre skallet.",
      signal: "Klar for integrasjon",
    }),
  },
  {
    id: "school",
    label: "Skole",
    shortLabel: "SK",
    accent: "gold",
    module: SchoolModule,
  },
  {
    id: "gaming",
    label: "Gaming",
    shortLabel: "GG",
    accent: "coral",
    module: createPlaceholderModule({
      id: "gaming",
      eyebrow: "FRITID",
      title: "Gaming",
      description: "Spillstatus og hurtighandlinger kan legges til senere.",
      signal: "Plass reservert",
    }),
  },
]);
