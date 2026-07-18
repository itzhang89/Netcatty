import { definePlugin } from "@netcatty/plugin-sdk";

export default definePlugin({
  activate(context) {
    context.logger.info("Hello Netcatty example activated", {
      pluginId: context.pluginId,
    });
  },
});
