				import worker, * as OTHER_EXPORTS from "D:\\OneDrive\\Documents\\secure-mail-console 2\\worker.js";
				import * as __MIDDLEWARE_0__ from "D:\\OneDrive\\Documents\\secure-mail-console 2\\node_modules\\wrangler\\templates\\middleware\\middleware-ensure-req-body-drained.ts";
import * as __MIDDLEWARE_1__ from "D:\\OneDrive\\Documents\\secure-mail-console 2\\node_modules\\wrangler\\templates\\middleware\\middleware-miniflare3-json-error.ts";

				export * from "D:\\OneDrive\\Documents\\secure-mail-console 2\\worker.js";

				export const __INTERNAL_WRANGLER_MIDDLEWARE__ = [
					...(OTHER_EXPORTS.__INJECT_FOR_TESTING_WRANGLER_MIDDLEWARE__ ?? []),
					__MIDDLEWARE_0__.default,__MIDDLEWARE_1__.default
				]
				export default worker;