// Native Windows process ownership. Built with the
// .NET Framework compiler included with Windows; no WSL or administrator needed.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Collections.Generic;

class WindowsProcess {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct ProcessEntry {
        public uint dwSize, cntUsage, th32ProcessID;
        public UIntPtr th32DefaultHeapID;
        public uint th32ModuleID, cntThreads, th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
        public int cb;
        public string lpReserved, lpDesktop, lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public ushort wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
        public IntPtr hProcess, hThread;
        public uint dwProcessId, dwThreadId;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr processAttrs, IntPtr threadAttrs, bool inherit, uint flags, IntPtr env, string cwd, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll")] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    static void Check(bool success) {
        if (!success) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    static int Stop(string[] args) {
        using (var root = Process.GetProcessById(int.Parse(args[1]))) {
            var rootHandle = root.Handle;
            if (root.StartTime.ToUniversalTime().Ticks.ToString() != args[2]) return 1;
            var parents = new Dictionary<int, int>();
            IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
            Check(snapshot != new IntPtr(-1));
            try {
                var entry = new ProcessEntry(); entry.dwSize = (uint)Marshal.SizeOf(entry);
                if (Process32First(snapshot, ref entry)) do {
                    parents[(int)entry.th32ProcessID] = (int)entry.th32ParentProcessID;
                } while (Process32Next(snapshot, ref entry));
            } finally { CloseHandle(snapshot); }
            var descendants = new List<Process>();
            try {
                foreach (var item in parents) {
                    int cursor = item.Key;
                    var seen = new HashSet<int>();
                    while (parents.ContainsKey(cursor) && seen.Add(cursor)) {
                        cursor = parents[cursor];
                        if (cursor != root.Id) continue;
                        try { var child = Process.GetProcessById(item.Key); var handle = child.Handle; descendants.Add(child); } catch (ArgumentException) { }
                        break;
                    }
                }
                // Only the identity-checked owned job supervisor is signalled.
                Check(TerminateProcess(rootHandle, 1));
                if (!root.WaitForExit(5000)) return 1;
                foreach (var child in descendants) if (!child.WaitForExit(5000)) return 1;
                return 0;
            } finally { foreach (var child in descendants) child.Dispose(); }
        }
    }
    // CommandLineToArgvW/CRT quoting. No command interpreter sees these args.
    static string Quote(string value) {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') result.Append('\\', slashes * 2 + 1).Append(c);
            else result.Append('\\', slashes).Append(c);
            slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    static int Run(string[] args) {
        // Open the parent before launching anything, avoiding a parent-pid reuse race.
        Process parent = Process.GetProcessById(int.Parse(args[1]));
        if (parent.StartTime.ToUniversalTime().Ticks.ToString() != args[2]) return 70;
        var parentHandle = parent.Handle;
        var monitor = new Thread(() => { parent.WaitForExit(); Environment.Exit(1); });
        monitor.IsBackground = true;
        monitor.Start();
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        Check(job != IntPtr.Zero);
        ProcessInfo child = new ProcessInfo();
        try {
            var limits = new ExtendedLimits();
            limits.BasicLimitInformation.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE; no breakaway
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)));
            var startup = new StartupInfo();
            startup.cb = Marshal.SizeOf(startup);
            startup.dwFlags = 0x100; // STARTF_USESTDHANDLES
            startup.hStdInput = GetStdHandle(-10);
            startup.hStdOutput = GetStdHandle(-11);
            startup.hStdError = GetStdHandle(-12);
            Check(SetHandleInformation(startup.hStdInput, 1, 1));
            Check(SetHandleInformation(startup.hStdOutput, 1, 1));
            Check(SetHandleInformation(startup.hStdError, 1, 1));
            var command = new StringBuilder();
            for (int i = 3; i < args.Length; i++) {
                if (i > 3) command.Append(' ');
                command.Append(Quote(args[i]));
            }
            Check(CreateProcess(args[3], command, IntPtr.Zero, IntPtr.Zero, true,
                0x4 | 0x08000000, IntPtr.Zero, null, ref startup, out child));
            try {
                Check(AssignProcessToJobObject(job, child.hProcess));
                Check(ResumeThread(child.hThread) != uint.MaxValue);
            } catch { TerminateProcess(child.hProcess, 70); throw; }
            WaitForSingleObject(child.hProcess, uint.MaxValue);
            uint code;
            Check(GetExitCodeProcess(child.hProcess, out code));
            return unchecked((int)code);
        } finally {
            CloseHandle(job); // also kills descendants left behind by a successful CLI
            if (child.hProcess != IntPtr.Zero) CloseHandle(child.hProcess);
            if (child.hThread != IntPtr.Zero) CloseHandle(child.hThread);
            parent.Dispose();
        }
    }
    static SecurityIdentifier CurrentSid { get { return WindowsIdentity.GetCurrent().User; } }
    static FileSystemSecurity Security(string path) {
        return Directory.Exists(path) ? (FileSystemSecurity)Directory.GetAccessControl(path) : File.GetAccessControl(path);
    }
    static bool Private(string path) {
        var security = Security(path);
        if (!security.GetOwner(typeof(SecurityIdentifier)).Equals(CurrentSid)) return false;
        foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
            if (rule.AccessControlType != AccessControlType.Allow) continue;
            string sid = rule.IdentityReference.Value;
            if (sid != CurrentSid.Value && sid != "S-1-5-18") return false;
        }
        return true;
    }
    static void Protect(string path) {
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new Exception("Private directory cannot be a reparse point");
        var previous = Security(path);
        if (!previous.GetOwner(typeof(SecurityIdentifier)).Equals(CurrentSid)) throw new Exception("Private directory is owned by another user");
        var security = Directory.GetAccessControl(path, AccessControlSections.Access);
        security.SetAccessRuleProtection(true, false);
        foreach (FileSystemAccessRule rule in security.GetAccessRules(true, false, typeof(SecurityIdentifier))) security.RemoveAccessRuleSpecific(rule);
        var flags = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
        security.AddAccessRule(new FileSystemAccessRule(CurrentSid, FileSystemRights.FullControl, flags, PropagationFlags.None, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier("S-1-5-18"), FileSystemRights.FullControl, flags, PropagationFlags.None, AccessControlType.Allow));
        Directory.SetAccessControl(path, security);
    }
    static int Main(string[] args) {
        try {
            if (args[0] == "run") return Run(args);
            if (args[0] == "stop") return Stop(args);
            if (args[0] == "identity") {
                using (var process = Process.GetProcessById(int.Parse(args[1]))) {
                    if (process.HasExited) return 1;
                    Console.WriteLine(process.StartTime.ToUniversalTime().Ticks.ToString());
                    Console.WriteLine(process.MainModule.FileName);
                }
                return 0;
            }
            if (args[0] == "protect") { Protect(args[1]); return 0; }
            if (args[0] == "private") return Private(args[1]) ? 0 : 1;
            return 64;
        } catch (Exception error) {
            Console.Error.WriteLine("devchestra-windows: " + error.Message);
            return 70;
        }
    }
}
