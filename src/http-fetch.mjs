/** Node 22's native fetch uses a legacy dispatcher protocol. Keep Host POSTs
 * on the same Undici version as DSH's web, proxy and MCP transports; loading
 * web_fetch must not break later signed resource or model requests.
 */
export { fetch as hostFetch } from 'undici';
