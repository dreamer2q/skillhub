export function parseArgs(argv) {
	const args = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith("--")) {
			args._.push(arg);
			continue;
		}

		const key = arg.slice(2);
		const next = argv[i + 1];
		if (next && !next.startsWith("--")) {
			if (args[key] == null) args[key] = next;
			else args[key] = Array.isArray(args[key]) ? [...args[key], next] : [args[key], next];
			i++;
		} else {
			args[key] = true;
		}
	}
	return args;
}

export function collectFilters(value) {
	if (value == null || value === true) return [];
	if (Array.isArray(value)) return value.flatMap(collectFilters);
	return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

export function requireArg(args, name, usage) {
	if (!args[name] || args[name] === true) {
		console.error(`Missing required --${name}`);
		console.error(usage);
		process.exit(1);
	}
	return args[name];
}
