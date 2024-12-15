import { load } from "jsr:@std/dotenv";
import { Octokit } from "https://esm.sh/octokit@4.0.2?dts";
import { VertexAI } from "https://esm.sh/@google-cloud/vertexai@1.9.2?dts"

await load({ export: true });

const githubToken = Deno.env.get("GH_ACCESS_TOKEN");

if (!githubToken) {
	console.error("GitHub Token が設定されていません。");
	Deno.exit(1);
}

const octokit = new Octokit({ auth: githubToken });

octokit.rest.users.getAuthenticated();

const saveHashToJson = async (data: string, hashFilePath: string) => {
	try {
		await Deno.writeTextFile(hashFilePath, data);
		console.log(`${hashFilePath}にハッシュ値を保存しました。`);
	} catch (error) {
		console.error(error);
		Deno.exit(1);
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
			Deno.exit(1);
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
		Deno.exit(1);
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
		const existingsHashes = JSON.parse(hashData);

		const changedFiles = repoFiles.filter((file) => {
			return existingsHashes[file.path] !== file.sha;
		})

		return changedFiles;
	} catch (error) {
		if (error instanceof Deno.errors.NotFound) {
			console.log("ハッシュファイルが見つかりませんでした。");
			return repoFiles;
		} else {
			console.error(error);
			Deno.exit(1);
		}
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

    if (resp.response.candidates && resp.response.candidates.length > 0) {
        const extractedTexts = resp.response.candidates.flatMap(candidate => 
            candidate.content.parts.map(part => part.text)
        );
        
        return extractedTexts; // ここでtextを返す
    } else {
        console.error("No candidates found in the response.");
        return; // 何も返さない（undefinedを返す）
    }
}

const writeFile = async (content: string, filePath: string) => {
	try {
		await Deno.writeTextFile(filePath, content);
		console.log(`${filePath}に翻訳結果を保存しました。`);
	} catch (error) {
		console.error(error);
		Deno.exit(1);
	}
}

const main = async () => {
	const owner = Deno.env.get("GH_OWNER");
	const repo = Deno.env.get("GH_REPO");
	const directoryPath = Deno.env.get("TARGET_DIRECTORY_PATH");
	const hashFilePath = Deno.env.get("HASH_FILE_PATH");

	console.log("owner:", owner);
	console.log("repo:", repo);
	console.log("directoryPath:", directoryPath);
	console.log("hashFilePath:", hashFilePath);

	if (!owner || !repo || !directoryPath || !hashFilePath) {
		console.error("owner, repo, directoryPath, hashFilePath が設定されていません。");
		Deno.exit(1);
	}

	const filesInRepo = await getFilesInDirectory(owner, repo, directoryPath);

	if (!filesInRepo) {
		console.error("ファイルが見つかりませんでした。");
		Deno.exit(1);
	}

	const changedFiles = await loadAndDetectDiffs(filesInRepo, hashFilePath);

    if (changedFiles && changedFiles.length > 0) {
        console.log("変更されたファイル：", changedFiles);

        for (const file of changedFiles) {
            const translatedContent = await translateText(file.content_url);
            if (translatedContent !== undefined) {
				await writeFile(translatedContent.join('\n'), file.path);
            } else {
                console.error(`Translation returned undefined for: ${file.content_url}`);
            }
        }

        // 新しいハッシュを生成
        const newHashes: Record<string, string> = changedFiles.reduce((acc, file) => {
            acc[file.path] = file.sha;
            return acc;
        }, {} as Record<string, string>);

        await saveHashToJson(JSON.stringify(newHashes, null, 2), hashFilePath);

		Deno.exit(0);
    } else {
        console.log("変更されたファイルはありません。");
		Deno.exit(0);
    }
}

await main();
