#include <windows.h>
#include <wchar.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int wmain(int argc, wchar_t **argv) {
  HANDLE out=GetStdHandle(STD_OUTPUT_HANDLE); DWORD wrote;
  if(argc>1 && _wcsicmp(argv[1],L"--version")==0){const char *version="codex-cli 0.164.0-alpha.11.1\n";WriteFile(out,version,(DWORD)strlen(version),&wrote,NULL);return 0;}
#ifdef PATCHED_FAKE
  if(argc>1 && _wcsicmp(argv[1],L"app-server")==0){wchar_t *marker=_wgetenv(L"PATCH_MARKER");if(marker){HANDLE f=CreateFileW(marker,GENERIC_WRITE,0,NULL,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,NULL);if(f!=INVALID_HANDLE_VALUE){DWORD written;WriteFile(f,"started",7,&written,NULL);CloseHandle(f);}}return 2;}
#endif
  char count[32]; sprintf(count,"argc=%d|",argc); WriteFile(out,count,(DWORD)strlen(count),&wrote,NULL);
  for(int i=1;i<argc;i++) { int n=WideCharToMultiByte(CP_UTF8,0,argv[i],-1,NULL,0,NULL,NULL); char *b=(char*)malloc(n); WideCharToMultiByte(CP_UTF8,0,argv[i],-1,b,n,NULL,NULL); WriteFile(out,b,(DWORD)(n-1),&wrote,NULL); WriteFile(out,"|",1,&wrote,NULL); free(b); }
  wchar_t *code=_wgetenv(L"FAKE_EXIT_CODE"); return code?_wtoi(code):0;
}

