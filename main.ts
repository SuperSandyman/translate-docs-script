import { load } from "jsr:@std/dotenv";
import { Octokit } from "https://esm.sh/octokit@4.0.2?dts";
import { VertexAI } from "https://esm.sh/@google-cloud/vertexai@1.9.2?dts"

await load({ export: true });

const octokit = new Octokit({ auth: Deno.env.get("GH_ACCESS_TOKEN") });

octokit.rest.users.getAuthenticated();

const saveHashToJson = async (data: string, hashFilePath: string) => {
	try {
		await Deno.writeTextFile(hashFilePath, data);
		console.log(`${hashFilePath}にハッシュ値を保存しました。`);
	} catch (error) {
		console.error(error);
	}
};

const getFilesInDirectory = async (
	owner: string,
	repo: string,
	path: string,
) => {
	try {
		const extention = Deno.env.get("TARGET_FILE_EXTENSION");

		if (!extention) {
			console.error("extension が設定されていません。");
			return;
		}

		const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
		const defaultBranch = repoData.default_branch;

		const { data: treeData } = await octokit.rest.git.getTree({
			owner,
			repo,
			tree_sha: defaultBranch,
			recursive: "true",
		});

		const files = treeData.tree.filter((item) =>
			item.path?.startsWith(path) && 
			item.type === "blob" && 
			item.path.endsWith(extention) && 
			item.path !== undefined && 
			item.sha !== undefined
		);

		return files.map((file) => ({
			path: file.path as string,
			sha: file.sha as string,
			content_url:
				`https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/${file.path}`,
		}));
	} catch (error) {
		console.error(error);
	}
};

interface FileInfo {
	path: string;
	sha: string;
	content_url: string;
}

const loadAndDetectDiffs = async ( repoFiles: FileInfo[], hashFilePath: string ) => {
	try {
		const hashData = await Deno.readTextFile(hashFilePath);
		const exitingsHashes = JSON.parse(hashData);

		const changedFiles = repoFiles.filter((file) => {
			return exitingsHashes[file.path] !== file.sha;
		})

		return changedFiles;
	} catch (error) {
		console.error(error);
		return [];
	}
}

const translateText = async (content_url: string) => {
	const content = await fetch(content_url).then((res) => res.text());
	const prompt_url = Deno.env.get("PROMPT_URL");

	const projectId = Deno.env.get("VERTEX_AI_PROJECT_ID");
	const location = Deno.env.get("VERTEX_AI_LOCATION");
	const model = Deno.env.get("VERTEX_AI_MODEL");

	if (!projectId || !location || !model || !prompt_url) {
		console.error("projectId, location, model, prompt_url が設定されていません。");
		return;
	}

	const prompt = await fetch(prompt_url).then((res) => res.text());

	const vertex_ai = new VertexAI({ project:projectId, location:location });

	const generativeModel = vertex_ai.getGenerativeModel({
		model: model,
		generationConfig: {maxOutputTokens: 8192}
	})

	const request = {
		contents: [{ role: "user", parts: [{text: `${prompt}\n${content}`}] }],
	}
	const resp = await generativeModel.generateContent(request);

	return JSON.stringify(await resp.response);
}

const writeFile = async (content: string, filePath: string) => {
	try {
		await Deno.writeTextFile(filePath, content);
		console.log(`${filePath}に翻訳結果を保存しました。`);
	} catch (error) {
		console.error(error);
	}
}

const main = async () => {
	const owner = Deno.env.get("GITHUB_OWNER");
	const repo = Deno.env.get("GITHUB_REPOSITORY");
	const directoryPath = Deno.env.get("TARGET_DIRECTORY_PATH");
	const hashFilePath = Deno.env.get("HASH_FILE_PATH");

	if (!owner || !repo || !directoryPath || !hashFilePath) {
		console.error("owner, repo, directoryPath, hashFilePath が設定されていません。");
		return;
	}

	const filesInRepo = await getFilesInDirectory(owner, repo, directoryPath);

	if (!filesInRepo) {
		console.error("ファイルが見つかりませんでした。");
		return;
	}

	const changedFiles = await loadAndDetectDiffs(filesInRepo, hashFilePath);

	console.log("変更されたファイル：", changedFiles);

	for (const file of changedFiles) {
		const translatedContent = await translateText(file.content_url);
        if (translatedContent !== undefined) {
            await writeFile(translatedContent, file.path);
        } else {
            console.error(`Translation returned undefined for: ${file.content_url}`);
        }
	}

	const newHashes: Record<string, string> = changedFiles.reduce((acc, file) => {
		acc[file.path] = file.sha;
		return acc;
	}, {} as Record<string, string>);

	await saveHashToJson(JSON.stringify(newHashes), hashFilePath);
}

await main();
