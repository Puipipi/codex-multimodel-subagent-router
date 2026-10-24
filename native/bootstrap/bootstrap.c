#define UNICODE
#define _UNICODE
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <tlhelp32.h>
#include <shellapi.h>
#include <bcrypt.h>
#include <shlobj.h>
#include <wchar.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef APPROVED_PATCH_SHA256
#define APPROVED_PATCH_SHA256 ""
#endif
#define MAX_PATH_CHARS 32768
#define MAX_RECEIPT 16384
#define STARTUP_GRACE_MS 1800
static const wchar_t *FAMILY_PREFIX = L"OpenAI.Codex_";
static const wchar_t *FAMILY_SUFFIX = L"_x64__2p2nqsd0c76g0";


typedef struct { wchar_t exe[MAX_PATH_CHARS]; wchar_t packageVersion[128]; } Official;

static int regular_file(const wchar_t *p) {
  DWORD a = GetFileAttributesW(p);
  return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY) && !(a & FILE_ATTRIBUTE_REPARSE_POINT);
}
static int same_path(const wchar_t *a, const wchar_t *b) { return _wcsicmp(a,b)==0; }
static int starts_i(const wchar_t *a, const wchar_t *b) { return _wcsnicmp(a,b,wcslen(b))==0; }

static int valid_package_path(const wchar_t *image, Official *out) {
  wchar_t full[MAX_PATH_CHARS];
  if(!GetFullPathNameW(image,MAX_PATH_CHARS,full,NULL)) return 0;
  wchar_t *package=wcsstr(full,L"\\WindowsApps\\OpenAI.Codex_");
  wchar_t *app=wcsstr(full,L"\\app\\Codex.exe");
  if(!package || !app) return 0;
  wchar_t *version=package+wcslen(L"\\WindowsApps\\OpenAI.Codex_");
  wchar_t *pkgEnd=wcsstr(version,FAMILY_SUFFIX);
  if(!pkgEnd || pkgEnd>app) return 0;
  wchar_t versionText[128]; size_t n=(size_t)(pkgEnd-version);
  if(n==0 || n>=128) return 0;
  wmemcpy(versionText,version,n); versionText[n]=0;
  wchar_t resource[MAX_PATH_CHARS]; wcsncpy(resource,full,MAX_PATH_CHARS-1); resource[MAX_PATH_CHARS-1]=0;
  app=wcsstr(resource,L"\\app\\Codex.exe"); if(!app) return 0;
  wcscpy(app,L"\\app\\resources\\codex.exe");
  if(!regular_file(resource)) return 0;
  wcscpy(out->exe,resource); wcscpy(out->packageVersion,versionText); return 1;
}
static int parent_official(Official *out) {
  HANDLE snap=CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS,0); if(snap==INVALID_HANDLE_VALUE) return 0;
  PROCESSENTRY32W e; e.dwSize=sizeof(e); DWORD pid=GetCurrentProcessId(), parent=0;
  if(Process32FirstW(snap,&e)) do { if(e.th32ProcessID==pid){parent=e.th32ParentProcessID;break;} } while(Process32NextW(snap,&e));
  for(int i=0;i<12 && parent;i++) {
    HANDLE proc=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,FALSE,parent);
    wchar_t image[MAX_PATH_CHARS]; DWORD size=MAX_PATH_CHARS; int found=0;
    if(proc && QueryFullProcessImageNameW(proc,0,image,&size)) found=valid_package_path(image,out);
    PROCESSENTRY32W p; p.dwSize=sizeof(p); DWORD next=0;
    if(Process32FirstW(snap,&p)) do { if(p.th32ProcessID==parent){next=p.th32ParentProcessID;break;} } while(Process32NextW(snap,&p));
    if(proc) CloseHandle(proc); if(found){CloseHandle(snap);return 1;} parent=next;
  }
  CloseHandle(snap); return 0;
}
static int version_greater(const wchar_t *a,const wchar_t *b) {
  const wchar_t *x=a,*y=b;
  for(int i=0;i<4;i++) { unsigned long av=wcstoul(x,(wchar_t**)&x,10), bv=wcstoul(y,(wchar_t**)&y,10); if(av!=bv)return av>bv; if(*x==L'.')x++; if(*y==L'.')y++; }
  return 0;
}
static int installed_official(Official *out) {
  wchar_t pf[MAX_PATH_CHARS]; DWORD n=GetEnvironmentVariableW(L"ProgramFiles",pf,MAX_PATH_CHARS); if(!n||n>=MAX_PATH_CHARS)return 0;
  wchar_t root[MAX_PATH_CHARS]; _snwprintf(root,MAX_PATH_CHARS,L"%s\\WindowsApps\\OpenAI.Codex_*_x64__2p2nqsd0c76g0",pf);
  WIN32_FIND_DATAW d; HANDLE f=FindFirstFileW(root,&d); if(f==INVALID_HANDLE_VALUE)return 0;
  wchar_t best[MAX_PATH_CHARS]=L"", bestVersion[128]=L"";
  do {
    wchar_t path[MAX_PATH_CHARS]; _snwprintf(path,MAX_PATH_CHARS,L"%s\\WindowsApps\\%s\\app\\Codex.exe",pf,d.cFileName);
    wchar_t *v=(wchar_t*)d.cFileName+wcslen(FAMILY_PREFIX); wchar_t *end=wcsstr(v,L"_x64__2p2nqsd0c76g0"); if(!end)continue;
    wchar_t ver[128]; size_t len=(size_t)(end-v); if(len==0||len>=128)continue; wmemcpy(ver,v,len); ver[len]=0;
    wchar_t resource[MAX_PATH_CHARS]; wcscpy(resource,path); wchar_t *app=wcsstr(resource,L"\\app\\Codex.exe"); if(!app)continue; wcscpy(app,L"\\app\\resources\\codex.exe"); if(!regular_file(resource))continue;
    if(!best[0]||version_greater(ver,bestVersion)){wcscpy(best,resource);wcscpy(bestVersion,ver);}
  } while(FindNextFileW(f,&d)); FindClose(f);
  if(!best[0]) return 0;
  wcscpy(out->exe,best); wcscpy(out->packageVersion,bestVersion); return 1;
}
static int sha256_file(const wchar_t *path,char out[65]) {
  HANDLE f=CreateFileW(path,GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_DELETE,NULL,OPEN_EXISTING,FILE_FLAG_SEQUENTIAL_SCAN,NULL); if(f==INVALID_HANDLE_VALUE)return 0;
  BCRYPT_ALG_HANDLE alg=NULL; BCRYPT_HASH_HANDLE h=NULL; DWORD objLen=0,cb=0; PUCHAR object=NULL; UCHAR digest[32]; int ok=0;
  if(BCryptOpenAlgorithmProvider(&alg,BCRYPT_SHA256_ALGORITHM,NULL,0)<0)goto done;
  if(BCryptGetProperty(alg,BCRYPT_OBJECT_LENGTH,(PUCHAR)&objLen,sizeof(objLen),&cb,0)<0)goto done;
  object=(PUCHAR)HeapAlloc(GetProcessHeap(),0,objLen); if(!object)goto done;
  if(BCryptCreateHash(alg,&h,object,objLen,NULL,0,0)<0)goto done;
  BYTE buf[65536]; DWORD got=0; while(ReadFile(f,buf,sizeof(buf),&got,NULL)&&got){if(BCryptHashData(h,buf,got,0)<0)goto done;}
  if(BCryptFinishHash(h,digest,sizeof(digest),0)<0)goto done;
  for(int i=0;i<32;i++) sprintf(out+i*2,"%02x",digest[i]);
  out[64]=0; ok=1;
done: if(h)BCryptDestroyHash(h);if(object)HeapFree(GetProcessHeap(),0,object);if(alg)BCryptCloseAlgorithmProvider(alg,0);CloseHandle(f);return ok;
}
static int query_cli_version(const wchar_t *exe,char *out,size_t cap) {
  SECURITY_ATTRIBUTES sa={sizeof(sa),NULL,TRUE}; HANDLE rd=NULL,wr=NULL;
  if(!CreatePipe(&rd,&wr,&sa,4096)) return 0;
  SetHandleInformation(rd,HANDLE_FLAG_INHERIT,0);
  HANDLE nul=CreateFileW(L"NUL",GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE,&sa,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,NULL);
  if(nul==INVALID_HANDLE_VALUE){CloseHandle(rd);CloseHandle(wr);return 0;}
  wchar_t command[MAX_PATH_CHARS+32]; _snwprintf(command,MAX_PATH_CHARS+32,L"\"%s\" --version",exe);
  STARTUPINFOW si; ZeroMemory(&si,sizeof(si));si.cb=sizeof(si);si.dwFlags=STARTF_USESTDHANDLES|STARTF_USESHOWWINDOW;si.wShowWindow=SW_HIDE;si.hStdInput=nul;si.hStdOutput=wr;si.hStdError=wr;
  PROCESS_INFORMATION pi;ZeroMemory(&pi,sizeof(pi));BOOL ok=CreateProcessW(exe,command,NULL,NULL,TRUE,CREATE_NO_WINDOW,NULL,NULL,&si,&pi);
  CloseHandle(wr);CloseHandle(nul);if(!ok){CloseHandle(rd);return 0;}
  DWORD wait=WaitForSingleObject(pi.hProcess,5000),code=1; if(wait==WAIT_OBJECT_0)GetExitCodeProcess(pi.hProcess,&code);
  CloseHandle(pi.hThread);CloseHandle(pi.hProcess);
  if(wait!=WAIT_OBJECT_0||code!=0){CloseHandle(rd);return 0;}
  DWORD got=0;BOOL read=ReadFile(rd,out,(DWORD)(cap-1),&got,NULL);CloseHandle(rd);if(!read||!got)return 0;out[got]=0;
  while(got&& (out[got-1]=='\r'||out[got-1]=='\n'||out[got-1]==' '||out[got-1]=='\t'))out[--got]=0;
  const char *prefix="codex-cli ";if(strncmp(out,prefix,strlen(prefix))!=0)return 0;memmove(out,out+strlen(prefix),strlen(out+strlen(prefix))+1);return out[0]!=0;
}
static char *read_text(const wchar_t *p) {
  HANDLE f=CreateFileW(p,GENERIC_READ,FILE_SHARE_READ,NULL,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,NULL);if(f==INVALID_HANDLE_VALUE)return NULL;
  DWORD n=GetFileSize(f,NULL);if(n==INVALID_FILE_SIZE||n>MAX_RECEIPT){CloseHandle(f);return NULL;} char *s=(char*)HeapAlloc(GetProcessHeap(),HEAP_ZERO_MEMORY,n+1);DWORD got=0;
  if(!s||!ReadFile(f,s,n,&got,NULL)||got!=n){if(s)HeapFree(GetProcessHeap(),0,s);CloseHandle(f);return NULL;}CloseHandle(f);return s;
}
static int json_string(const char *json,const char *key,char *out,size_t cap) {
  char name[96];_snprintf(name,sizeof(name),"\"%s\"",key);const char *p=strstr(json,name);if(!p)return 0;p=strchr(p,':');if(!p)return 0;p++;while(*p==' '||*p=='\t')p++;if(*p!='\"')return 0;p++;
  size_t n=0;while(*p&&*p!='\"'&&n+1<cap){if(*p=='\\'&&p[1])p++;out[n++]=*p++;}if(*p!='\"')return 0;out[n]=0;return 1;
}
static int json_number_one(const char *json,const char *key) {char name[96];_snprintf(name,sizeof(name),"\"%s\"",key);const char*p=strstr(json,name);if(!p)return 0;p=strchr(p,':');if(!p)return 0;while(*++p==' '||*p=='\t');return *p=='1'&&(p[1]==','||p[1]=='}');}
static int beneath(const wchar_t *root,const wchar_t *candidate) {wchar_t a[MAX_PATH_CHARS],b[MAX_PATH_CHARS];if(!GetFullPathNameW(root,MAX_PATH_CHARS,a,NULL)||!GetFullPathNameW(candidate,MAX_PATH_CHARS,b,NULL))return 0;size_t n=wcslen(a);if(a[n-1]!=L'\\'){a[n++]=L'\\';a[n]=0;}return _wcsnicmp(a,b,n)==0;}
static int compatible_patch(const Official *official,const wchar_t *runtimeRoot,wchar_t patch[MAX_PATH_CHARS]) {
  if(!APPROVED_PATCH_SHA256[0])return 0;
  wchar_t receiptPath[MAX_PATH_CHARS];_snwprintf(receiptPath,MAX_PATH_CHARS,L"%s\\compatibility.json",runtimeRoot);char *j=read_text(receiptPath);if(!j)return 0;
  char officialHash[65],patchHash[65],recordedOfficial[65],recordedVersion[128],recordedPackage[128],probeStatus[32],probeName[64],probeVersion[128],recordedApproved[65],actualVersion[128];

  int ok=0;
  if(!json_number_one(j,"schemaVersion"))goto done;
  if(!sha256_file(official->exe,officialHash))goto done;
  if(!query_cli_version(official->exe,actualVersion,sizeof(actualVersion)))goto done;
  // The app-server installation probe stores all compatibility identity fields in the receipt.
  if(!json_string(j,"officialSha256",recordedOfficial,sizeof(recordedOfficial))||strcmp(officialHash,recordedOfficial))goto done;
  if(!json_string(j,"desktopPackageVersion",recordedPackage,sizeof(recordedPackage)))goto done;
  char packageUtf8[128]; if(!WideCharToMultiByte(CP_UTF8,0,official->packageVersion,-1,packageUtf8,sizeof(packageUtf8),NULL,NULL)||strcmp(packageUtf8,recordedPackage))goto done;
    char patchUtf8[MAX_PATH_CHARS*4];if(!json_string(j,"patchedPath",patchUtf8,sizeof(patchUtf8)))goto done;
  if(!MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,patchUtf8,-1,patch,MAX_PATH_CHARS))goto done;
  if(!beneath(runtimeRoot,patch)||!regular_file(patch)||!sha256_file(patch,patchHash))goto done;
  if(!json_string(j,"patchedSha256",recordedApproved,sizeof(recordedApproved))||strcmp(patchHash,recordedApproved)||_stricmp(patchHash,APPROVED_PATCH_SHA256))goto done;
  if(!json_string(j,"status",probeStatus,sizeof(probeStatus))||strcmp(probeStatus,"passed"))goto done;
  if(!json_string(j,"probe",probeName,sizeof(probeName))||strcmp(probeName,"app-server-initialize"))goto done;
  if(!json_string(j,"officialVersion",recordedVersion,sizeof(recordedVersion))||strcmp(recordedVersion,actualVersion))goto done;
  if(!json_string(j,"cliVersion",probeVersion,sizeof(probeVersion))||strcmp(recordedVersion,probeVersion))goto done;
  // Prevent selecting the official executable itself as a patched child.
  if(same_path(official->exe,patch))goto done;
  ok=1;
done: HeapFree(GetProcessHeap(),0,j);return ok;
}
static int append_quoted(wchar_t *dst,size_t cap,size_t *at,const wchar_t *arg) {
  if(*at+2>=cap) return 0;
  dst[(*at)++]=L'"';size_t slashes=0;
  for(const wchar_t*p=arg;*p;p++) { if(*p==L'\\'){slashes++;continue;} if(*p==L'"'){for(size_t i=0;i<slashes*2+1;i++){if(*at+1>=cap)return 0;dst[(*at)++]=L'\\';}dst[(*at)++]=L'"';slashes=0;continue;} while(slashes>0){slashes--;if(*at+1>=cap)return 0;dst[(*at)++]=L'\\';}slashes=0;if(*at+1>=cap)return 0;dst[(*at)++]=*p; }
  for(size_t i=0;i<slashes*2;i++){if(*at+1>=cap)return 0;dst[(*at)++]=L'\\';}if(*at+2>=cap)return 0;dst[(*at)++]=L'"';dst[*at]=0;return 1;
}
static int launch_child(const wchar_t *exe,int argc,wchar_t **argv,int probeFallback) {
  wchar_t *cmd=(wchar_t*)HeapAlloc(GetProcessHeap(),HEAP_ZERO_MEMORY,131072*sizeof(wchar_t));if(!cmd)return 127;size_t at=0;
  if(!append_quoted(cmd,131072,&at,exe)){HeapFree(GetProcessHeap(),0,cmd);return 127;}
  for(int i=1;i<argc;i++){if(at+1>=131072){HeapFree(GetProcessHeap(),0,cmd);return 127;}cmd[at++]=L' ';cmd[at]=0;if(!append_quoted(cmd,131072,&at,argv[i])){HeapFree(GetProcessHeap(),0,cmd);return 127;}}
  HANDLE stds[3]={0};for(int i=0;i<3;i++){DWORD id=i==0?STD_INPUT_HANDLE:i==1?STD_OUTPUT_HANDLE:STD_ERROR_HANDLE;HANDLE h=GetStdHandle(id);int owned=0;if(!h||h==INVALID_HANDLE_VALUE){h=CreateFileW(L"NUL",i==0?GENERIC_READ:GENERIC_WRITE,FILE_SHARE_READ|FILE_SHARE_WRITE,NULL,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,NULL);owned=1;}if(!h||h==INVALID_HANDLE_VALUE||!DuplicateHandle(GetCurrentProcess(),h,GetCurrentProcess(),&stds[i],0,TRUE,DUPLICATE_SAME_ACCESS)){if(owned&&h&&h!=INVALID_HANDLE_VALUE)CloseHandle(h);for(int j=0;j<i;j++)if(stds[j])CloseHandle(stds[j]);HeapFree(GetProcessHeap(),0,cmd);return probeFallback?-1:127;}if(owned)CloseHandle(h);}
  SIZE_T bytes=0;InitializeProcThreadAttributeList(NULL,1,0,&bytes);LPPROC_THREAD_ATTRIBUTE_LIST attrs=(LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(),0,bytes);if(!attrs){for(int i=0;i<3;i++)if(stds[i])CloseHandle(stds[i]);HeapFree(GetProcessHeap(),0,cmd);return 127;}
  STARTUPINFOEXW si;ZeroMemory(&si,sizeof(si));si.StartupInfo.cb=sizeof(si);si.StartupInfo.dwFlags=STARTF_USESHOWWINDOW|STARTF_USESTDHANDLES;si.StartupInfo.wShowWindow=SW_HIDE;si.StartupInfo.hStdInput=stds[0];si.StartupInfo.hStdOutput=stds[1];si.StartupInfo.hStdError=stds[2];
  InitializeProcThreadAttributeList(attrs,1,0,&bytes);if(!UpdateProcThreadAttribute(attrs,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,stds,sizeof(stds),NULL,NULL)){DeleteProcThreadAttributeList(attrs);HeapFree(GetProcessHeap(),0,attrs);for(int i=0;i<3;i++)CloseHandle(stds[i]);HeapFree(GetProcessHeap(),0,cmd);return probeFallback?-1:127;}si.lpAttributeList=attrs;
  PROCESS_INFORMATION pi;ZeroMemory(&pi,sizeof(pi));BOOL created=CreateProcessW(exe,cmd,NULL,NULL,TRUE,CREATE_NO_WINDOW|EXTENDED_STARTUPINFO_PRESENT,NULL,NULL,&si.StartupInfo,&pi);
  DeleteProcThreadAttributeList(attrs);HeapFree(GetProcessHeap(),0,attrs);for(int i=0;i<3;i++)if(stds[i])CloseHandle(stds[i]);HeapFree(GetProcessHeap(),0,cmd);
  if(!created)return probeFallback?-1:126;
  if(probeFallback){if(WaitForSingleObject(pi.hProcess,STARTUP_GRACE_MS)==WAIT_OBJECT_0){CloseHandle(pi.hThread);CloseHandle(pi.hProcess);return -1;}WaitForSingleObject(pi.hProcess,INFINITE);DWORD code=1;GetExitCodeProcess(pi.hProcess,&code);CloseHandle(pi.hThread);CloseHandle(pi.hProcess);return (int)code;}
  WaitForSingleObject(pi.hProcess,INFINITE);DWORD code=1;GetExitCodeProcess(pi.hProcess,&code);CloseHandle(pi.hThread);CloseHandle(pi.hProcess);return (int)code;
}
static void write_status(const wchar_t *runtimeRoot,int healthy) {
  CreateDirectoryW(runtimeRoot,NULL);wchar_t p[MAX_PATH_CHARS],tmp[MAX_PATH_CHARS];_snwprintf(p,MAX_PATH_CHARS,L"%s\\upgrade-status.json",runtimeRoot);_snwprintf(tmp,MAX_PATH_CHARS,L"%s\\upgrade-status.%lu.tmp",runtimeRoot,GetCurrentProcessId());
  HANDLE f=CreateFileW(tmp,GENERIC_WRITE,0,NULL,CREATE_ALWAYS,FILE_ATTRIBUTE_HIDDEN,NULL);if(f==INVALID_HANDLE_VALUE)return;
  char text[512];_snprintf(text,sizeof(text),"{\"state\":\"%s\",\"reason\":%s,\"repairAttempted\":false,\"updatedAt\":\"%lu\"}\n",healthy?"healthy":"disabled",healthy?"null":"\"兼容补丁尚未通过当前 Codex 版本验证\"",GetTickCount());DWORD wrote=0;WriteFile(f,text,(DWORD)strlen(text),&wrote,NULL);FlushFileBuffers(f);CloseHandle(f);MoveFileExW(tmp,p,MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH);
}
static int runtime_root(wchar_t *out) {
#ifdef TEST_HARNESS
  wchar_t *testRoot=_wgetenv(L"CODEX_BOOTSTRAP_TEST_RUNTIME_ROOT");if(testRoot&&wcslen(testRoot)<MAX_PATH_CHARS){wcscpy(out,testRoot);return 1;}
#endif
  wchar_t home[MAX_PATH_CHARS];DWORD n=GetEnvironmentVariableW(L"CODEX_HOME",home,MAX_PATH_CHARS);if(!n||n>=MAX_PATH_CHARS){n=GetEnvironmentVariableW(L"USERPROFILE",home,MAX_PATH_CHARS);if(!n||n>=MAX_PATH_CHARS)return 0;wcscat(home,L"\\.codex");}
  _snwprintf(out,MAX_PATH_CHARS,L"%s\\router-runtime",home);return 1;
}
int WINAPI wWinMain(HINSTANCE instance,HINSTANCE prev,LPWSTR cmdline,int show) {
  (void)instance;(void)prev;(void)cmdline;(void)show;
  int argc=0;wchar_t **argv=CommandLineToArgvW(GetCommandLineW(),&argc);if(!argv)return 127;
  wchar_t self[MAX_PATH_CHARS];DWORD sn=GetModuleFileNameW(NULL,self,MAX_PATH_CHARS);if(!sn||sn>=MAX_PATH_CHARS){LocalFree(argv);return 127;}
  Official official;ZeroMemory(&official,sizeof(official));int found=0;
#ifdef TEST_HARNESS
  wchar_t *testOfficial=_wgetenv(L"CODEX_BOOTSTRAP_TEST_OFFICIAL");wchar_t *testPackage=_wgetenv(L"CODEX_BOOTSTRAP_TEST_PACKAGE_VERSION");if(testOfficial&&testPackage&&wcslen(testOfficial)<MAX_PATH_CHARS&&wcslen(testPackage)<128&&regular_file(testOfficial)){wcscpy(official.exe,testOfficial);wcscpy(official.packageVersion,testPackage);found=1;}
#else
  found=parent_official(&official);if(!found)found=installed_official(&official);
#endif
  if(!found||same_path(self,official.exe)){LocalFree(argv);return 126;}
  wchar_t root[MAX_PATH_CHARS];if(!runtime_root(root)){LocalFree(argv);return 126;}
  wchar_t patch[MAX_PATH_CHARS];int usePatch=compatible_patch(&official,root,patch);
  write_status(root,usePatch);
  if(usePatch){int appServer=0;for(int i=1;i<argc;i++)if(_wcsicmp(argv[i],L"app-server")==0)appServer=1;int result=launch_child(patch,argc,argv,appServer);if(result>=0){LocalFree(argv);return result;}write_status(root,0);}
  int result=launch_child(official.exe,argc,argv,0);LocalFree(argv);return result;
}











