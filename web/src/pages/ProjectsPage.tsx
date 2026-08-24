import { useEffect, useState } from 'react';
import { get, post } from '../api';

interface Project {
  id: string;
  name: string;
  repo_path: string;
  source: string;
  git_url?: string;
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [msg, setMsg] = useState('');
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState('');

  const load = () => get<Project[]>('/api/projects').then(setProjects).catch((e) => setMsg(e.message));
  useEffect(() => { load(); }, []);

  const showErr = (e: any) => setMsg(e instanceof Error ? e.message : String(e));

  /* --- 从零新建 --- */
  const createNew = async () => {
    const name = (document.getElementById('np-name') as HTMLInputElement).value.trim();
    const repo = (document.getElementById('np-path') as HTMLInputElement).value.trim();
    if (!name) { setMsg('请填写项目名称'); return; }
    try {
      await post('/api/projects', { name, source: 'new', repo_path: repo || null });
      setMsg('项目已创建');
      load();
    } catch (e) { showErr(e); }
  };

  /* --- Git 地址导入 --- */
  const importGit = async () => {
    const name = (document.getElementById('ng-name') as HTMLInputElement).value.trim();
    const url = (document.getElementById('ng-url') as HTMLInputElement).value.trim();
    if (!name || !url) { setMsg('请填写项目名称与 Git 地址'); return; }
    setUploading(true);
    setMsg('');
    try {
      const r = await post('/api/projects/import-git', { name, git_url: url });
      setMsg(`已从 Git 导入：${r.repo_path}`);
      load();
    } catch (e) { showErr(e); } finally { setUploading(false); }
  };

  /* --- 上传 zip --- */
  const onZip = async (file: File) => {
    const name = (document.getElementById('nz-name') as HTMLInputElement).value.trim();
    if (!name) { setMsg('请先填写项目名称'); return; }
    if (!file) return;
    setUploading(true);
    setMsg('');
    setProgress('正在上传并解压…');
    try {
      const b64 = await fileToBase64(file);
      const r = await post('/api/projects/import-upload', { name, zipBase64: b64 });
      setMsg(`项目已导入：${r.repo_path}`);
      load();
    } catch (e) { showErr(e); } finally { setUploading(false); setProgress(''); }
  };

  /* --- 上传文件夹（网页选文件夹，逐文件上传） --- */
  const onFolder = async (files: FileList | null) => {
    const name = (document.getElementById('nf-name') as HTMLInputElement).value.trim();
    if (!name) { setMsg('请先填写项目名称'); return; }
    if (!files || files.length === 0) return;
    const list = Array.from(files);
    const EXCLUDE = /(^|\/)(node_modules|\.git|dist|build|\.next|__pycache__|\.venv)(\/|$)/;
    const keep = list.filter((f) => f.webkitRelativePath && !EXCLUDE.test(f.webkitRelativePath));
    if (keep.length === 0) { setMsg('未找到可上传的文件'); return; }
    setUploading(true);
    setMsg('');
    try {
      const BATCH = 40;
      for (let i = 0; i < keep.length; i += BATCH) {
        const batch = keep.slice(i, i + BATCH);
        const filesPayload = [];
        for (const f of batch) {
          const content = await fileToBase64(f);
          filesPayload.push({ path: f.webkitRelativePath.replace(/^[^/]+\//, ''), content });
        }
        const done = i + BATCH >= keep.length;
        const r = await post('/api/projects/import-files', { name, files: filesPayload, total: keep.length, done });
        setProgress(`已上传 ${Math.min(i + BATCH, keep.length)} / ${keep.length} 个文件…`);
        if (done) {
          setMsg(`文件夹已导入：${(r as any).repo_path}`);
          load();
          break;
        }
      }
    } catch (e) { showErr(e); } finally { setUploading(false); setProgress(''); }
  };

  const fileToBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
      reader.onerror = () => reject(new Error('读取文件失败'));
      reader.readAsDataURL(file);
    });

  const SOURCE_LABEL: Record<string, string> = { new: '从零新建', upload: '上传导入', git: 'Git 仓库', path: '服务器路径' };

  return (
    <div>
      <h2 className="page-title">项目（你的代码库）</h2>

      <div className="card">
        <h3 style={{ marginBottom: 12 }}>导入代码（4 种方式）</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          {/* 从零新建 */}
          <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: 12 }}>
            <strong>① 从零新建</strong>
            <div className="form-row" style={{ marginTop: 8 }}><input id="np-name" placeholder="项目名称" /></div>
            <div className="form-row"><input id="np-path" placeholder="服务器目录（留空自动创建）" /></div>
            <button className="btn btn-primary" onClick={createNew}>创建空项目</button>
          </div>
          {/* Git 导入 */}
          <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: 12 }}>
            <strong>② Git 仓库导入</strong>
            <div className="form-row" style={{ marginTop: 8 }}><input id="ng-name" placeholder="项目名称" /></div>
            <div className="form-row"><input id="ng-url" placeholder="https://github.com/xxx/yyy.git" /></div>
            <button className="btn btn-primary" onClick={importGit} disabled={uploading}>{uploading ? '克隆中…' : '从 Git 导入'}</button>
          </div>
          {/* zip 上传 */}
          <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: 12 }}>
            <strong>③ 上传 zip 包</strong>
            <div className="form-row" style={{ marginTop: 8 }}><input id="nz-name" placeholder="项目名称" /></div>
            <div className="form-row">
              <input type="file" accept=".zip" disabled={uploading}
                onChange={(e) => e.target.files?.[0] && onZip(e.target.files[0])} />
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-3)' }}>选择你电脑上的 zip 压缩包（项目代码打包）</div>
          </div>
          {/* 文件夹上传 */}
          <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: 12 }}>
            <strong>④ 选择本机文件夹</strong>
            <div className="form-row" style={{ marginTop: 8 }}><input id="nf-name" placeholder="项目名称" /></div>
            <div className="form-row">
              <input type="file" multiple disabled={uploading} {...{ webkitdirectory: '', directory: '' } as any}
                onChange={(e) => onFolder(e.target.files)} />
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-3)' }}>直接选你电脑上的项目文件夹，自动上传到服务器（排除 node_modules/.git 等）</div>
          </div>
        </div>
        {uploading && <div className="msg">{progress || '处理中…'}</div>}
        {msg && <div className="msg msg-ok">{msg}</div>}
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 12 }}>项目列表</h3>
        <table>
          <thead><tr><th>名称</th><th>来源</th><th>服务器路径</th><th>Git 地址</th></tr></thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>{SOURCE_LABEL[p.source] ?? p.source}</td>
                <td className="mono">{p.repo_path}</td>
                <td className="mono">{p.git_url ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
