param([Parameter(Mandatory=$true)][string]$RequestPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$lease = $null; $held = $false
try {
  $request = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([int]$request.root_pid -lt 1) { throw 'NATIVE_OWNER_INVALID' }
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -AssemblyName WindowsBase
  Add-Type -AssemblyName System.Drawing
  Add-Type -ReferencedAssemblies @([System.Windows.Automation.AutomationElement].Assembly.Location,[System.Windows.Automation.ControlType].Assembly.Location,[System.Windows.Rect].Assembly.Location,[System.Drawing.Bitmap].Assembly.Location) -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Windows.Automation;
using System.Drawing;
using System.Drawing.Imaging;
public static class BlomaOwnedUi {
  public delegate bool EnumCallback(IntPtr window, IntPtr extra);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback,IntPtr extra);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr window);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr window,IntPtr target,uint flags);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window,out Rect rect);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool SetProp(IntPtr window,string name,IntPtr value);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr GetProp(IntPtr window,string name);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr RemoveProp(IntPtr window,string name);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr window,EnumCallback callback,IntPtr extra);
  static string generationKey;
  static string Generation(IntPtr hwnd,bool create){
    if(hwnd==IntPtr.Zero)return null;
    uint pid;GetWindowThreadProcessId(hwnd,out pid);if(!Owned((int)pid))throw new Exception("NATIVE_REFERENCE_STALE");
    var a=GetProp(hwnd,generationKey+".a");var b=GetProp(hwnd,generationKey+".b");
    if(a==IntPtr.Zero||b==IntPtr.Zero){
      if(!create)throw new Exception("NATIVE_REFERENCE_STALE");
      // Opaque integers, not allocated handles or pointers. No target code/DOM/data.
      using(var rng=RandomNumberGenerator.Create()){
        var bytes=new byte[8];rng.GetBytes(bytes);a=new IntPtr((BitConverter.ToInt64(bytes,0)&Int64.MaxValue));
        if(a==IntPtr.Zero)a=new IntPtr(1);
        rng.GetBytes(bytes);b=new IntPtr((BitConverter.ToInt64(bytes,0)&Int64.MaxValue));
        if(b==IntPtr.Zero)b=new IntPtr(1);
      }
      if(!SetProp(hwnd,generationKey+".a",a)||!SetProp(hwnd,generationKey+".b",b))throw new Exception("NATIVE_WINDOW_GENERATION_UNAVAILABLE");
    }
    uint after;GetWindowThreadProcessId(hwnd,out after);
    if(after!=pid||!Owned((int)after)||GetProp(hwnd,generationKey+".a")!=a||GetProp(hwnd,generationKey+".b")!=b)throw new Exception("NATIVE_REFERENCE_STALE");
    return a.ToInt64().ToString(CultureInfo.InvariantCulture)+":"+b.ToInt64().ToString(CultureInfo.InvariantCulture);
  }
  public static void Release(int[] ids,string[] starts,string key){
    owners=new Dictionary<int,string>();for(int i=0;i<ids.Length;i++)owners.Add(ids[i],starts[i]);
    EnumCallback remove=(hwnd,extra)=>{uint pid;GetWindowThreadProcessId(hwnd,out pid);if(owners.ContainsKey((int)pid)&&Owned((int)pid)){RemoveProp(hwnd,key+".a");RemoveProp(hwnd,key+".b");if(GetProp(hwnd,key+".a")!=IntPtr.Zero||GetProp(hwnd,key+".b")!=IntPtr.Zero)throw new Exception("NATIVE_GENERATION_CLEANUP_FAILED");}return true;};
    EnumWindows((hwnd,extra)=>{uint pid;GetWindowThreadProcessId(hwnd,out pid);if(owners.ContainsKey((int)pid)&&Owned((int)pid)){remove(hwnd,extra);EnumChildWindows(hwnd,remove,extra);}return true;},IntPtr.Zero);
  }
  public class Window { public string Handle,Started,Name,Generation; public int Pid,Dpi; public bool Enabled,Minimized,Modal; public int[] Bounds; }
  public class Row { public string Runtime,Name,Role,AutomationId,Value,ContentHash,State,WindowHandle,Generation; public int Depth; public bool Enabled,Offscreen,Password,TextTruncated; public double[] Bounds; public string[] Patterns; }
  public class View { public Window[] Windows; public string Selected,Fingerprint; public Row[] Nodes; public bool Truncated; }
  static Dictionary<string,AutomationElement> targets;
  static Dictionary<int,string> owners;
  static string Clip(string value,int limit){if(value==null||value.Length<=limit)return value;int end=Char.IsHighSurrogate(value[limit-1])?limit-1:limit;return value.Substring(0,end);}
  static string Hash(string value){using(var hash=SHA256.Create())return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(value))).Replace("-","").ToLowerInvariant();}
  static string Start(int pid) { using(var process=Process.GetProcessById(pid)) { return process.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture); } }
  public static string Started(int pid) { return Start(pid); }
  static bool Owned(int pid) { string expected; return owners.TryGetValue(pid,out expected) && Start(pid)==expected; }
  public static View Observe(int[] ids,string[] starts,string handle,string key) {
    generationKey=key;if(!Environment.Is64BitProcess)throw new Exception("NATIVE_GENERATION_PLATFORM_UNSUPPORTED");
    owners=new Dictionary<int,string>(); for(int i=0;i<ids.Length;i++)owners.Add(ids[i],starts[i]);
    try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch(EntryPointNotFoundException) { }
    var windows=new List<Window>();
    EnumWindows((hwnd,extra)=>{
      uint raw;GetWindowThreadProcessId(hwnd,out raw);int pid=(int)raw;
      if(!owners.ContainsKey(pid) || !IsWindowVisible(hwnd))return true;
      if(!Owned(pid))throw new Exception("NATIVE_PROCESS_IDENTITY_CHANGED");
      Rect rect;if(!GetWindowRect(hwnd,out rect))throw new Exception("NATIVE_WINDOW_UNAVAILABLE");
      var element=AutomationElement.FromHandle(hwnd);object pattern;bool modal=false;
      if(element.TryGetCurrentPattern(WindowPattern.Pattern,out pattern))modal=((WindowPattern)pattern).Current.IsModal;
      int dpi=0;try{dpi=(int)GetDpiForWindow(hwnd);}catch(EntryPointNotFoundException){}
      windows.Add(new Window{Handle=hwnd.ToInt64().ToString(CultureInfo.InvariantCulture),Pid=pid,Started=Start(pid),Name=element.Current.Name,Generation=Generation(hwnd,true),
        Dpi=dpi,Enabled=IsWindowEnabled(hwnd),Minimized=IsIconic(hwnd),Modal=modal,Bounds=new int[]{rect.Left,rect.Top,rect.Right-rect.Left,rect.Bottom-rect.Top}});
      if(windows.Count>16)throw new Exception("NATIVE_WINDOW_LIMIT");return true;
    },IntPtr.Zero);
    windows.Sort((a,b)=>String.CompareOrdinal(a.Handle,b.Handle));
    var view=new View{Windows=windows.ToArray(),Nodes=new Row[0]};
    if(String.IsNullOrEmpty(handle) && windows.Count==1)handle=windows[0].Handle;
    if(String.IsNullOrEmpty(handle))return view;
    Window selected=windows.Find(w=>w.Handle==handle);if(selected==null)throw new Exception("NATIVE_WINDOW_NOT_OWNED");
    view.Selected=handle; targets=new Dictionary<string,AutomationElement>();
    var pending=new Queue<Tuple<AutomationElement,int>>();pending.Enqueue(Tuple.Create(AutomationElement.FromHandle(new IntPtr(Int64.Parse(handle,CultureInfo.InvariantCulture))),0));
    var rows=new List<Row>(); var walker=TreeWalker.ControlViewWalker;
    while(pending.Count>0){
      if(rows.Count>=1000){view.Truncated=true;break;}
      var item=pending.Dequeue();var element=item.Item1;var current=element.Current;
      if(!Owned(current.ProcessId))throw new Exception("NATIVE_ELEMENT_PROCESS_NOT_OWNED");
      string runtime=String.Join(",",element.GetRuntimeId());
      if(targets.ContainsKey(runtime))throw new Exception("NATIVE_AMBIGUOUS_RUNTIME_ID");targets.Add(runtime,element);
      object pattern;string value=null;var patterns=new List<string>();
      foreach(var supported in element.GetSupportedPatterns())patterns.Add(supported.ProgrammaticName.Replace("Identifiers.Pattern",""));
      patterns.Sort(StringComparer.Ordinal);
      if(!current.IsPassword && element.TryGetCurrentPattern(ValuePattern.Pattern,out pattern))value=((ValuePattern)pattern).Current.Value;
      var state=new StringBuilder();
      if(element.TryGetCurrentPattern(TogglePattern.Pattern,out pattern))state.Append("toggle:").Append(((TogglePattern)pattern).Current.ToggleState).Append(';');
      if(element.TryGetCurrentPattern(SelectionItemPattern.Pattern,out pattern))state.Append("selected:").Append(((SelectionItemPattern)pattern).Current.IsSelected).Append(';');
      if(element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern,out pattern))state.Append("expand:").Append(((ExpandCollapsePattern)pattern).Current.ExpandCollapseState).Append(';');
      var bounds=current.BoundingRectangle;string name=current.Name,automation=current.AutomationId;
      var native=new IntPtr(unchecked((long)(uint)current.NativeWindowHandle));
      rows.Add(new Row{WindowHandle=native.ToInt64().ToString(CultureInfo.InvariantCulture),Generation=Generation(native,true),Runtime=runtime,Depth=item.Item2,Name=Clip(name,512),Role=current.ControlType.ProgrammaticName.Replace("ControlType.",""),
        AutomationId=Clip(automation,256),Value=Clip(value,1024),TextTruncated=(name!=null&&name.Length>512)||(automation!=null&&automation.Length>256)||(value!=null&&value.Length>1024),ContentHash=Hash(Hash(name??"")+Hash(automation??"")+Hash(value??"")),State=state.ToString(),Enabled=current.IsEnabled,Offscreen=current.IsOffscreen,Password=current.IsPassword,
        Bounds=new double[]{bounds.X,bounds.Y,bounds.Width,bounds.Height},Patterns=patterns.ToArray()});
      var child=walker.GetFirstChild(element);
      if(item.Item2>=24){if(child!=null)view.Truncated=true;continue;}
      int siblings=0;while(child!=null){if(++siblings>1000 || pending.Count>=1000){view.Truncated=true;break;}pending.Enqueue(Tuple.Create(child,item.Item2+1));child=walker.GetNextSibling(child);}
    }
    view.Nodes=rows.ToArray();
    // Length-prefixed fields prevent name/value delimiter collisions. Fixed
    // ordering avoids PowerShell hashtable/property serialization identities.
    var canonical=new StringBuilder();Action<object> add=(value)=>{string s=Convert.ToString(value,CultureInfo.InvariantCulture)??"";canonical.Append(s.Length).Append(':').Append(s);};
    foreach(var window in view.Windows){add(window.Handle);add(window.Generation);add(window.Pid);add(window.Started);add(window.Name);add(window.Enabled);add(window.Minimized);add(window.Modal);add(window.Dpi);foreach(var b in window.Bounds)add(b);}
    add(view.Selected);add(view.Truncated);
    foreach(var row in view.Nodes){add(row.Runtime);add(row.WindowHandle);add(row.Generation);add(row.Depth);add(row.Name);add(row.Role);add(row.AutomationId);add(row.Value);add(row.ContentHash);add(row.State);add(row.Enabled);add(row.Offscreen);add(row.Password);foreach(var b in row.Bounds)add(b);foreach(var p in row.Patterns)add(p);add("end-row");}
    using(var hash=SHA256.Create())view.Fingerprint=BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(canonical.ToString()))).Replace("-","").ToLowerInvariant();
    return view;
  }
  public static string Capture(View view,string path){
    if(String.IsNullOrEmpty(view.Selected))return "NATIVE_SCREENSHOT_WINDOW_NOT_SELECTED";
    var window=Array.Find(view.Windows,w=>w.Handle==view.Selected);var hwnd=new IntPtr(Int64.Parse(view.Selected,CultureInfo.InvariantCulture));uint pid;GetWindowThreadProcessId(hwnd,out pid);
    if(window==null||pid!=window.Pid||Start(window.Pid)!=window.Started||Generation(hwnd,false)!=window.Generation)return "NATIVE_SCREENSHOT_IDENTITY_CHANGED";
    IntPtr previous=IntPtr.Zero;
    try{
      // PrintWindow renders in the target window's DPI awareness. A PMv2
      // physical-size bitmap for an unaware provider can otherwise acquire a
      // large black border. Image pixels are not UIA screen coordinates.
      try{previous=SetThreadDpiAwarenessContext(GetWindowDpiAwarenessContext(hwnd));}catch(EntryPointNotFoundException){}
      Rect rect;if(!GetWindowRect(hwnd,out rect))return "NATIVE_SCREENSHOT_UNAVAILABLE";
      int width=rect.Right-rect.Left,height=rect.Bottom-rect.Top;
      if(window.Minimized||width<1||height<1||width>3840||height>2160)return "NATIVE_SCREENSHOT_BOUNDS_UNSUPPORTED";
      using(var image=new Bitmap(width,height,PixelFormat.Format32bppArgb))using(var graphics=Graphics.FromImage(image)){
        var target=graphics.GetHdc();bool captured;try{captured=PrintWindow(hwnd,target,2);}finally{graphics.ReleaseHdc(target);}
        if(!captured)return "NATIVE_SCREENSHOT_UNAVAILABLE";
        uint after;GetWindowThreadProcessId(hwnd,out after);if(after!=pid||Start(window.Pid)!=window.Started||Generation(hwnd,false)!=window.Generation)return "NATIVE_SCREENSHOT_IDENTITY_CHANGED";
        image.Save(path,ImageFormat.Png);
      }
      return null;
    }finally{if(previous!=IntPtr.Zero)SetThreadDpiAwarenessContext(previous);}
  }
  public static string Act(View view,string expected,string runtime,string kind,string value){
    if(view.Fingerprint!=expected)throw new Exception("NATIVE_REFERENCE_STALE");
    var window=Array.Find(view.Windows,w=>w.Handle==view.Selected);
    if(window==null || !window.Enabled || window.Minimized)throw new Exception("NATIVE_WINDOW_BLOCKED");
    if(Array.Exists(view.Windows,w=>w.Modal && w.Handle!=view.Selected))throw new Exception("NATIVE_MODAL_REQUIRES_SELECTION");
    AutomationElement element;if(!targets.TryGetValue(runtime,out element))throw new Exception("NATIVE_REFERENCE_STALE");
    if(!Owned(element.Current.ProcessId) || !element.Current.IsEnabled)throw new Exception("NATIVE_CONTROL_DISABLED_OR_STALE");
    var hwnd=new IntPtr(Int64.Parse(window.Handle,CultureInfo.InvariantCulture));
    var row=Array.Find(view.Nodes,r=>r.Runtime==runtime);
    if(Generation(hwnd,false)!=window.Generation||row==null||element.Current.NativeWindowHandle!=unchecked((int)Int64.Parse(row.WindowHandle,CultureInfo.InvariantCulture))||Generation(new IntPtr(Int64.Parse(row.WindowHandle,CultureInfo.InvariantCulture)),false)!=row.Generation)throw new Exception("NATIVE_REFERENCE_STALE");
    if(!IsWindowEnabled(hwnd)||IsIconic(hwnd))throw new Exception("NATIVE_WINDOW_BLOCKED");
    object pattern;
    switch(kind){
      case "invoke": if(!element.TryGetCurrentPattern(InvokePattern.Pattern,out pattern))break;((InvokePattern)pattern).Invoke();return "UIA.InvokePattern";
      case "fill": if(!element.TryGetCurrentPattern(ValuePattern.Pattern,out pattern))break;if(((ValuePattern)pattern).Current.IsReadOnly)throw new Exception("NATIVE_VALUE_READONLY");((ValuePattern)pattern).SetValue(value);return "UIA.ValuePattern";
      case "toggle": if(!element.TryGetCurrentPattern(TogglePattern.Pattern,out pattern))break;((TogglePattern)pattern).Toggle();return "UIA.TogglePattern";
      case "select": if(!element.TryGetCurrentPattern(SelectionItemPattern.Pattern,out pattern))break;((SelectionItemPattern)pattern).Select();return "UIA.SelectionItemPattern";
      case "expand": case "collapse": if(!element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern,out pattern))break;if(kind=="expand")((ExpandCollapsePattern)pattern).Expand();else((ExpandCollapsePattern)pattern).Collapse();return "UIA.ExpandCollapsePattern";
    }
    throw new Exception("NATIVE_PATTERN_UNSUPPORTED");
  }
}
'@
  $rootId = [int]$request.root_pid
  $rootStarted = [BlomaOwnedUi]::Started($rootId)
  if ($request.root_started -and [string]$request.root_started -ne $rootStarted) { throw 'NATIVE_PROCESS_IDENTITY_CHANGED' }
  if ([string]$request.generation_key -notmatch '^Bloma\.OwnedUi\.[a-f0-9-]{36}$') { throw 'NATIVE_GENERATION_KEY_INVALID' }
  if ($request.kind -notin @('bind','observe','act','release')) { throw 'NATIVE_REQUEST_INVALID' }
  if ($request.kind -eq 'act') {
    $lease = New-Object System.Threading.Mutex($false,'Local\BlomaOwnedNativePatterns')
    try { $held = $lease.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $held = $true }
    if (-not $held) { throw 'NATIVE_INPUT_BUSY' }
  }
  $owned = @{}; $owned[$rootId] = $rootStarted
  $rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate)
  do {
    $added = $false
    foreach ($row in $rows) {
      $parentId = [int]$row.ParentProcessId; $childId = [int]$row.ProcessId
      if ($owned.ContainsKey($parentId) -and -not $owned.ContainsKey($childId)) {
        try {
          $childStarted = [BlomaOwnedUi]::Started($childId)
          if ([long]$childStarted -ge [long]$owned[$parentId] -and [Math]::Abs($row.CreationDate.ToUniversalTime().Ticks - [long]$childStarted) -le 10) { $owned[$childId] = $childStarted; $added = $true }
        } catch { } # Process exited between the fixed census and identity lookup.
      }
    }
  } while ($added)
  $ids = @($owned.Keys | Sort-Object); $starts = @($ids | ForEach-Object { [string]$owned[$_] })
  if ([BlomaOwnedUi]::Started($rootId) -ne $rootStarted) { throw 'NATIVE_PROCESS_IDENTITY_CHANGED' }
  if ($request.kind -eq 'release') {
    [BlomaOwnedUi]::Release([int[]]$ids,[string[]]$starts,[string]$request.generation_key)
    @{ok=$true;root_started=$rootStarted;view=@{Windows=@();Nodes=@();Selected=$null;Fingerprint=$null}} | ConvertTo-Json -Compress -Depth 5
    exit 0
  }
  $view = [BlomaOwnedUi]::Observe([int[]]$ids,[string[]]$starts,[string]$request.window,[string]$request.generation_key)
  if ([BlomaOwnedUi]::Started($rootId) -ne $rootStarted) { throw 'NATIVE_PROCESS_IDENTITY_CHANGED' }
  $method = $null
  if ($request.kind -eq 'act') {
    $method = [BlomaOwnedUi]::Act($view,[string]$request.expected,[string]$request.runtime,[string]$request.control.kind,[string]$request.control.value)
  }
  $captureError = $null
  if ($request.capture_path -and $request.kind -ne 'act') { $captureError = [BlomaOwnedUi]::Capture($view,[string]$request.capture_path) }
  $encoded = @{ok=$true;root_started=$rootStarted;view=$view;method=$method;capture_error=$captureError} | ConvertTo-Json -Compress -Depth 10
  if ([System.Text.Encoding]::UTF8.GetByteCount($encoded) -gt 262144) { throw 'NATIVE_OUTPUT_LIMIT' }
  $encoded
} catch {
  $message = $_.Exception.Message
  $code = if ($message -match '(NATIVE_[A-Z_]+)') { $Matches[1] } else { 'NATIVE_ADAPTER_ERROR' }
  @{ok=$false;error=$code;detail=$message.Substring(0,[Math]::Min(1500,$message.Length))} | ConvertTo-Json -Compress
  exit 1
} finally { if ($held) { $lease.ReleaseMutex() }; if ($lease) { $lease.Dispose() } }
