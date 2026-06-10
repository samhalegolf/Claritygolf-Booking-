import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { calendarApiMiddleware } from "./server/calendar-api.mjs";

function clarityCalendarApi() {
  return {
    name: "clarity-calendar-api",
    configureServer(server) {
      server.middlewares.use(calendarApiMiddleware());
    },
    configurePreviewServer(server) {
      server.middlewares.use(calendarApiMiddleware());
    },
  };
}

export default defineConfig({
  plugins: [clarityCalendarApi(), react()],
});
