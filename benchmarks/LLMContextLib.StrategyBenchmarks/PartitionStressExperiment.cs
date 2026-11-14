// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Diagnostics;
using System.Reflection;
using System.Runtime;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading.Channels;
using Microsoft.Win32.SafeHandles;

namespace LLMContextLib.StrategyBenchmarks;

internal static class PartitionStressExperiment
{
    private const long PrivateLimit = 768L * 1024 * 1024;
    private static long Now => Stopwatch.GetTimestamp();
    private static long Ticks(double seconds) => (long)(seconds * Stopwatch.Frequency);
    private static Guid Id(int n) => new(n, 0, 0, new byte[8]);
    private static readonly ContextIndexKeys Shared = new(["shared"]);
    private static readonly ContextIndexKeys StateOne = new(["state:1"]);

    internal static int Run(string output, bool reverse, string[] arguments)
    {
        string suite = Value("--stress-suite") ?? "all";
        int seconds = int.Parse(Value("--seconds") ?? "8");
        int writers = int.Parse(Value("--writer-threads") ?? "1000");
        if (suite is not ("all" or "load" or "heap" or "scaling" or "threads") ||
            seconds is < 2 or > 30 || writers is < 1 or > 1000)
            throw new ArgumentException("Invalid bounded stress settings.");
        var sources = Program.SourceHashes();
        var results = new List<object>();
        Warm(false);
        Warm(true);
        if (suite is "all" or "load")
            foreach (int sessions in new[] { 1, 8 })
                foreach (int rate in new[] { 2000, 10000 })
                    Pair("Load", $"{sessions}s-{rate}rps",
                        (partitioned, position) => Load(partitioned, position, sessions, rate, seconds));
        if (suite is "all" or "heap")
            foreach (bool distinct in new[] { false, true })
                foreach (bool pinned in new[] { false, true })
                    Pair("Heap", $"{(distinct ? "distinct" : "common")}-{pinned}",
                        (partitioned, position) => Heap(partitioned, position, distinct, pinned));
        if (suite is "all" or "scaling")
            foreach (int partitions in new[] { 4, 64, 1024 })
                Pair("Scaling", $"{partitions}partitions",
                    (partitioned, position) => Scaling(partitioned, position, partitions));
        if (suite is "all" or "threads")
            foreach (int sessions in new[] { 1, writers })
                Pair("Threads", $"{writers}writers-{sessions}s",
                    (partitioned, position) => Threads(partitioned, position, writers, sessions));
        if (!sources.SequenceEqual(Program.SourceHashes())) throw new InvalidOperationException("Sources changed.");
        Save(complete: true);
        Console.WriteLine($"PASS {results.Count} stress cases: {Path.GetFullPath(output)}");
        return 0;

        void Save(bool complete)
        {
            string full = Path.GetFullPath(output);
            Directory.CreateDirectory(Path.GetDirectoryName(full)!);
            File.WriteAllText(complete ? full : full + ".partial.json", JsonSerializer.Serialize(new
            {
                Mode = "PartitionStress",
                RecordedAt = DateTimeOffset.UtcNow,
                Arguments = arguments,
                Complete = complete,
                Suite = suite,
                Seconds = seconds,
                WriterThreads = writers,
                Reverse = reverse,
                Runtime = RuntimeInformation.FrameworkDescription,
                Host = RuntimeInformation.OSDescription,
                Architecture = RuntimeInformation.ProcessArchitecture.ToString(),
                Environment.ProcessorCount,
                BuildSdk = typeof(Program).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>()
                .First(attribute => attribute.Key == "BuildSdk").Value,
                GCSettings.IsServerGC,
                LatencyMode = GCSettings.LatencyMode.ToString(),
                Stopwatch.Frequency,
                ProcessPrivateByteStopLimit = PrivateLimit,
                SourceHashes = sources,
                AssemblyHashes = Directory.EnumerateFiles(AppContext.BaseDirectory, "*.dll")
                .ToDictionary(path => Path.GetFileName(path)!, Program.Hash),
                Results = results
            }, Program.Json));
        }

        void Pair(string kind, string name, Func<bool, int, object> measure)
        {
            foreach (bool partitioned in reverse ? new[] { true, false } : new[] { false, true })
            {
                Collect();
                Console.WriteLine($"START {kind}/{name}/{Policy(partitioned)}");
                results.Add(measure(partitioned, partitioned == reverse ? 0 : 1));
                Save(complete: false);
                Console.WriteLine($"PASS {kind}/{name}/{Policy(partitioned)}");
            }
        }
        string? Value(string name)
        {
            int index = Array.IndexOf(arguments, name);
            return index >= 0 && index + 1 < arguments.Length ? arguments[index + 1] : null;
        }
    }

    private static string Policy(bool partitioned) => partitioned ? "Partitioned" : "ProducerEager";
    private static void Collect()
    {
        GC.Collect(2, GCCollectionMode.Forced, blocking: true, compacting: true);
        GC.WaitForPendingFinalizers();
        GC.Collect(2, GCCollectionMode.Forced, blocking: true, compacting: true);
    }

    private sealed class Fixture
    {
        internal readonly LLMSessionContext[] Sessions;
        internal readonly ContextIndexKeys[,] Keys;
        internal readonly int Entries, PerSegment, KeyCount;
        internal Fixture(int sessions, int entries, int perSegment, int keyCount, bool distinct = false)
        {
            (Entries, PerSegment, KeyCount) = (entries, perSegment, keyCount);
            Keys = new ContextIndexKeys[entries * 2, 2];
            for (int n = 0; n < entries * 2; n++)
                for (int variant = 0; variant < 2; variant++)
                    Keys[n, variant] = new(Enumerable.Range(0, keyCount - 3)
                        .Select(k => distinct ? $"e:{n}:v:{variant}:k:{k}" : $"v:{variant}:k:{k}")
                        .Concat(["shared", $"state:{variant}", $"entry:{n}"]));
            Sessions = Enumerable.Range(0, sessions).Select(s => new LLMSessionContext(
                Id(1 + s), Id(1000001), Id(1000002), 0, SessionStatus.Active,
                Enumerable.Range(0, (entries + perSegment - 1) / perSegment).ToImmutableSortedDictionary(
                    p => (long)p, p => new ContextSegment(p, 0, Enumerable.Range(p * perSegment,
                        Math.Min(perSegment, entries - p * perSegment)).Select(n => Entry(n, n, 0)).ToImmutableArray())),
                ImmutableDictionary<Guid, ConversationAnchor>.Empty)).ToArray();
        }
        internal ContextEntry Entry(int n, long sequence, int variant) =>
            new(Id(10000 + n), sequence, ContextRole.User, DateTimeOffset.UnixEpoch, new TextContent($"v:{variant}"))
            { IndexKeys = Keys[n, variant] };
        internal ILLMContextPolymorphicArray Open(bool partitioned)
        {
            var recipe = LLMContextFactory.Create(new()
            {
                MaximumEntriesPerSegment = PerSegment,
                MaximumEstimatedBytesPerSegment = 32 * 1024,
                EstimatedResidentByteBudget = 512 * 1024 * 1024,
                MaximumEstimatedRetainedBytes = 256 * 1024 * 1024,
                MaximumRetainedReads = 2048,
                AdmissionTimeout = TimeSpan.FromMilliseconds(5)
            }).WithProducerOwnedIndexing();
            if (partitioned) recipe = recipe.WithPartitionedIndexing(new()
            {
                MaximumEstimatedPartitionBytes = 8 * 1024 * 1024,
                MaximumEstimatedWorkingSetBytes = 4 * 1024 * 1024,
                MaximumWorkingSetEntries = Math.Max(64, PerSegment)
            });
            return recipe.Initialize(Sessions);
        }
    }

    private static void Warm(bool partitioned)
    {
        var fixture = new Fixture(1, 16, 8, 32);
        using var owner = fixture.Open(partitioned);
        for (int i = 0; i < 128; i++)
        {
            long revision = Revision(owner, Id(1));
            int variant = (i / 16) & 1;
            Check(owner.Apply(new(Id(1), revision, [new ReplaceEntry(Id(10000 + i % 16), new TextContent($"v:{variant}"))
            { IndexKeys = fixture.Keys[i % 16, variant] }])));
        }
        if (partitioned) CheckSync(owner.SynchronizeIndexAsync(Id(1)).GetAwaiter().GetResult());
        Verify(owner, Id(1), fixture.Entries * 2, Shared);
    }

    private static long Revision(ILLMContextPolymorphicArray owner, Guid session)
    {
        long revision = -1;
        owner.WithCurrent(session, read => revision = read.Session.Revision);
        return revision;
    }

    private static void Check(IContextMutationResult result)
    {
        if (result.Status != ContextMutationStatus.Applied)
            throw new InvalidOperationException($"{result.Status}: {result.Error}");
    }
    private static void CheckSync(ContextIndexSynchronization receipt)
    {
        if (!receipt.Succeeded) throw new InvalidOperationException(receipt.Error);
    }

    private static long Verify(ILLMContextPolymorphicArray owner, Guid session, int maximum, ContextIndexKeys query,
        Histogram? search = null)
    {
        long revision = -1;
        owner.WithCurrent(session, read =>
        {
            revision = read.Session.Revision;
            var entries = read.ReadRange(0, maximum + 1);
            long start = Now;
            var actual = read.SearchKeys(query, maximum + 1);
            search?.Add(Now - start);
            var expected = entries.Where(entry => query.Keys.All(key => entry.IndexKeys!.Keys
                .BinarySearch(key, StringComparer.Ordinal) >= 0)).Select(entry => entry.EntryId);
            if (!expected.SequenceEqual(actual.Select(hit => hit.EntryId)) ||
                actual.Any(hit => hit.SessionRevision != revision))
                throw new InvalidOperationException("Captured-content key/order/revision oracle mismatch.");
        });
        return revision;
    }

    private sealed class Histogram
    {
        public long[] Buckets { get; } = new long[1024];
        public long Count { get; private set; }
        public long Total { get; private set; }
        public long Maximum { get; private set; }
        internal void Add(long ticks)
        {
            int bucket = Math.Min(1023, (int)(Math.Log2(Math.Max(1, ticks)) * 32));
            Buckets[bucket]++;
            Count++;
            Total += ticks;
            Maximum = Math.Max(Maximum, ticks);
        }
        internal void Merge(Histogram other)
        {
            for (int i = 0; i < Buckets.Length; i++) Buckets[i] += other.Buckets[i];
            Count += other.Count;
            Total += other.Total;
            Maximum = Math.Max(Maximum, other.Maximum);
        }
    }

    private sealed class Worker
    {
        internal readonly long[] Statuses = new long[Enum.GetValues<ContextMutationStatus>().Length];
        internal readonly Histogram Apply = new(), EndToEnd = new(), Queue = new();
        internal long Attempts, Applied, FirstAttempt = long.MaxValue, LastAttempt;
        internal long AppliedSameState;
        internal readonly long[] AttemptsBySecond = new long[32], AppliedBySecond = new long[32];
    }

    private sealed class Pulse : IDisposable
    {
        private readonly EventWaitHandle? _wait;
        internal bool HighResolution => _wait is not null;
        internal Pulse()
        {
            if (!OperatingSystem.IsWindows()) return;
            var handle = CreateWaitableTimerExW(IntPtr.Zero, null, 2, 0x1F0003);
            if (handle.IsInvalid) { handle.Dispose(); return; }
            long due = -10000;
            if (!SetWaitableTimer(handle, ref due, 1, IntPtr.Zero, IntPtr.Zero, false))
            {
                handle.Dispose();
                return;
            }
            _wait = new(false, EventResetMode.AutoReset) { SafeWaitHandle = handle };
        }
        internal void Wait()
        {
            if (_wait is null) Thread.Sleep(1);
            else _wait.WaitOne();
        }
        public void Dispose() => _wait?.Dispose();

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeWaitHandle CreateWaitableTimerExW(IntPtr attributes, string? name,
            uint flags, uint access);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetWaitableTimer(SafeWaitHandle timer, ref long due, int period,
            IntPtr callback, IntPtr argument, [MarshalAs(UnmanagedType.Bool)] bool resume);
    }

    private readonly record struct Observation(long OffsetTicks, long ManagedBytes, long HeapAfterGcBytes,
        long CommittedGcBytes, long WorkingSetBytes, long PrivateBytes, long GcIndex);

    private sealed class Telemetry : IDisposable
    {
        private readonly Thread _thread;
        private readonly Process _process = Process.GetCurrentProcess();
        private readonly long _start = Now, _allocated = GC.GetTotalAllocatedBytes(true);
        private readonly TimeSpan _pause = GC.GetTotalPauseDuration();
        private readonly int[] _collections = [GC.CollectionCount(0), GC.CollectionCount(1), GC.CollectionCount(2)];
        private readonly TimeSpan _cpu;
        private readonly long _initialManaged = GC.GetTotalMemory(false);
        private readonly Pulse _pulse = new();
        private volatile bool _stop;
        internal volatile bool LimitExceeded;
        internal long ElapsedTicks => Now - _start;
        private readonly List<Observation> _observations = [];
        private long _samples, _last, _maxGap, _managedPeak, _gcPeak, _committedPeak, _workingPeak, _privatePeak;
        private long _allocatedEnd;
        private TimeSpan _pauseEnd, _cpuEnd;
        private int[] _collectionEnd = [];
        internal Telemetry()
        {
            _cpu = _process.TotalProcessorTime;
            _thread = new Thread(Sample) { IsBackground = true, Name = "PartitionStressSampler" };
            _thread.Start();
        }
        private void Sample()
        {
            long working = 0, privateBytes = 0;
            while (!_stop)
            {
                long now = Now;
                var info = GC.GetGCMemoryInfo();
                long managed = GC.GetTotalMemory(false);
                if (_samples % 20 == 0)
                {
                    _process.Refresh();
                    working = _process.WorkingSet64;
                    privateBytes = _process.PrivateMemorySize64;
                    if (privateBytes > PrivateLimit) LimitExceeded = true;
                }
                _managedPeak = Math.Max(_managedPeak, managed);
                _gcPeak = Math.Max(_gcPeak, info.HeapSizeBytes);
                _committedPeak = Math.Max(_committedPeak, info.TotalCommittedBytes);
                _workingPeak = Math.Max(_workingPeak, working);
                _privatePeak = Math.Max(_privatePeak, privateBytes);
                if (_last != 0) _maxGap = Math.Max(_maxGap, now - _last);
                _last = now;
                if (_samples++ % 10 == 0)
                    _observations.Add(new(now - _start, managed, info.HeapSizeBytes,
                        info.TotalCommittedBytes, working, privateBytes, info.Index));
                _pulse.Wait();
            }
        }
        public void Dispose()
        {
            if (_stop) return;
            _stop = true;
            _thread.Join();
            _pulse.Dispose();
            _allocatedEnd = GC.GetTotalAllocatedBytes(true);
            _pauseEnd = GC.GetTotalPauseDuration();
            _cpuEnd = _process.TotalProcessorTime;
            _collectionEnd = [GC.CollectionCount(0), GC.CollectionCount(1), GC.CollectionCount(2)];
            _process.Dispose();
        }
        internal object Result()
        {
            Dispose();
            if (LimitExceeded) throw new InvalidOperationException("Benchmark process exceeded its private-memory stop limit.");
            return new
            {
                Samples = _samples,
                MaximumSampleGapTicks = _maxGap,
                SampledManagedPeakBytes = _managedPeak,
                HighResolutionTimer = _pulse.HighResolution,
                InitialManagedBytes = _initialManaged,
                ObservedPostGcHeapPeakBytes = _gcPeak,
                ObservedGcCommittedPeakBytes = _committedPeak,
                SampledWorkingSetPeakBytes = _workingPeak,
                SampledPrivatePeakBytes = _privatePeak,
                AllocatedBytes = _allocatedEnd - _allocated,
                GcPauseTicks = (_pauseEnd - _pause).Ticks,
                CpuTicks = (_cpuEnd - _cpu).Ticks,
                Collections = _collectionEnd.Select((count, i) => count - _collections[i]).ToArray(),
                Observations = _observations
            };
        }
    }

    private readonly record struct Intent(int Sequence, long Due);

    private sealed class Traffic
    {
        internal long Start, Deadline, Offered, Dropped, Queries, OracleChecks, SyncRequests, SyncFailures;
        internal long SourceExpired;
        internal int InApply, PeakInApply;
        internal volatile bool Stop;
        internal readonly ConcurrentQueue<Exception> Errors = new();
        internal readonly Histogram Search = new(), Synchronization = new();
    }

    private static void WaitUntil(long deadline, Pulse? pulse = null)
    {
        while (true)
        {
            double ms = (deadline - Now) * 1000d / Stopwatch.Frequency;
            if (ms <= 0) return;
            if (pulse is null) Thread.Sleep(ms > 2 ? Math.Min(10, (int)ms - 1) : 1);
            else pulse.Wait();
        }
    }

    private static void Attempt(ILLMContextPolymorphicArray owner, Fixture fixture, Worker worker,
        Traffic traffic, int sequence, long due, int sessionNumber)
    {
        long begin = Now;
        worker.Attempts++;
        worker.FirstAttempt = Math.Min(worker.FirstAttempt, begin);
        worker.LastAttempt = begin;
        int second = (int)((begin - traffic.Start) / Stopwatch.Frequency);
        if (second is >= 0 and < 32 && begin < traffic.Deadline) worker.AttemptsBySecond[second]++;
        worker.Queue.Add(Math.Max(0, begin - due));
        ContextMutationStatus status;
        long applyStart = 0;
        try
        {
            Guid session = Id(1 + sessionNumber);
            int n = (sequence / Math.Max(1, fixture.Sessions.Length)) % fixture.Entries;
            int variant = (sequence / Math.Max(1, fixture.Sessions.Length * fixture.Entries)) & 1;
            var change = new ReplaceEntry(Id(10000 + n), new TextContent($"v:{variant}"))
            { IndexKeys = fixture.Keys[n, variant] };
            long revision = -1;
            bool sameState = false;
            owner.WithCurrent(session, read =>
            {
                revision = read.Session.Revision;
                if (!read.TryFindEntry(Id(10000 + n), out var prior))
                    throw new InvalidOperationException("Producer destination is missing.");
                sameState = prior.Content is TextContent text && text.Text == $"v:{variant}";
            });
            int active = Interlocked.Increment(ref traffic.InApply);
            int peak;
            do { peak = Volatile.Read(ref traffic.PeakInApply); }
            while (active > peak && Interlocked.CompareExchange(ref traffic.PeakInApply, active, peak) != peak);
            try
            {
                applyStart = Now;
                status = owner.Apply(new(session, revision, [change])).Status;
                if (status == ContextMutationStatus.Applied && sameState) worker.AppliedSameState++;
            }
            finally { Interlocked.Decrement(ref traffic.InApply); }
        }
        catch (InvalidOperationException error) when (error.Message.Contains("budget", StringComparison.OrdinalIgnoreCase))
        {
            status = ContextMutationStatus.AdmissionRejected;
        }
        long end = Now;
        worker.Statuses[(int)status]++;
        if (status == ContextMutationStatus.Applied) worker.Applied++;
        if (status == ContextMutationStatus.Applied && end < traffic.Deadline)
        {
            int completedSecond = (int)((end - traffic.Start) / Stopwatch.Frequency);
            if (completedSecond is >= 0 and < 32) worker.AppliedBySecond[completedSecond]++;
        }
        if (applyStart != 0) worker.Apply.Add(end - applyStart);
        worker.EndToEnd.Add(end - due);
    }

    private static Thread Auxiliary(Action action, Traffic traffic, string name)
    {
        var thread = new Thread(() =>
        {
            try { action(); }
            catch (Exception error) { traffic.Errors.Enqueue(error); traffic.Stop = true; }
        })
        { IsBackground = true, Name = name };
        thread.Start();
        return thread;
    }

    private static (Thread Query, Thread? Maintenance) StartAuxiliary(ILLMContextPolymorphicArray owner,
        Fixture fixture, bool partitioned, Traffic traffic)
    {
        var query = Auxiliary(() =>
        {
            WaitUntil(traffic.Start);
            int index = 0;
            while (!traffic.Stop && Now < traffic.Deadline)
            {
                Verify(owner, Id(1 + index % fixture.Sessions.Length), fixture.Entries * 2,
                    index % 2 == 0 ? Shared : StateOne, traffic.Search);
                traffic.Queries++;
                traffic.OracleChecks++;
                index++;
                Thread.Sleep(10);
            }
        }, traffic, "PartitionStressQueries");
        Thread? maintenance = partitioned ? Auxiliary(() =>
        {
            WaitUntil(traffic.Start);
            int index = 0;
            while (!traffic.Stop && Now < traffic.Deadline)
            {
                long start = Now;
                var result = owner.SynchronizeIndexAsync(Id(1 + index++ % fixture.Sessions.Length))
                    .GetAwaiter().GetResult();
                traffic.Synchronization.Add(Now - start);
                traffic.SyncRequests++;
                if (!result.Succeeded) traffic.SyncFailures++;
                Thread.Sleep(fixture.Sessions.Length > 8 ? 10 : 100);
            }
        }, traffic, "PartitionStressMaintenance") : null;
        return (query, maintenance);
    }

    private static object Load(bool partitioned, int position, int sessions, int rate, int seconds)
    {
        var fixture = new Fixture(sessions, 32, 8, 256);
        using var owner = fixture.Open(partitioned);
        var traffic = new Traffic();
        var workers = Enumerable.Range(0, 8).Select(_ => new Worker()).ToArray();
        var queue = Channel.CreateBounded<Intent>(new BoundedChannelOptions(128)
        { SingleWriter = true, FullMode = BoundedChannelFullMode.Wait });
        using var telemetry = new Telemetry();
        traffic.Start = Now + Ticks(0.1);
        traffic.Deadline = traffic.Start + Ticks(seconds);
        var consumers = workers.Select((worker, w) => Auxiliary(() =>
        {
            while (queue.Reader.WaitToReadAsync().AsTask().GetAwaiter().GetResult())
                while (queue.Reader.TryRead(out var intent))
                    Attempt(owner, fixture, worker, traffic, intent.Sequence, intent.Due, intent.Sequence % sessions);
        }, traffic, $"PartitionStressConsumer{w}")).ToArray();
        var auxiliary = StartAuxiliary(owner, fixture, partitioned, traffic);
        using var pacing = new Pulse();
        for (int n = 0; n < rate * seconds && !traffic.Stop && !telemetry.LimitExceeded; n++)
        {
            long due = traffic.Start + (long)(n * (double)Stopwatch.Frequency / rate);
            WaitUntil(due, pacing);
            if (Now >= traffic.Deadline)
            {
                long expired = rate * seconds - n;
                traffic.SourceExpired += expired;
                traffic.Dropped += expired;
                traffic.Offered += expired;
                break;
            }
            traffic.Offered++;
            if (!queue.Writer.TryWrite(new(n, due))) traffic.Dropped++;
        }
        WaitUntil(traffic.Deadline);
        queue.Writer.Complete();
        foreach (var thread in consumers) thread.Join();
        traffic.Stop = true;
        auxiliary.Query.Join();
        auxiliary.Maintenance?.Join();
        long drained = Now;
        telemetry.Dispose();
        var terminal = Finish(owner, fixture, partitioned, traffic, workers);
        return new
        {
            Suite = "Load",
            Name = $"{sessions}s-{rate}rps",
            Policy = Policy(partitioned),
            Position = position,
            Sessions = sessions,
            Writers = workers.Length,
            TargetRate = rate,
            WindowTicks = Ticks(seconds),
            DrainTicks = Math.Max(0, drained - traffic.Deadline),
            QueueCapacity = 128,
            traffic.Offered,
            traffic.Dropped,
            traffic.PeakInApply,
            Terminal = terminal,
            Telemetry = telemetry.Result()
            ,
            traffic.SourceExpired,
            HighResolutionPacing = pacing.HighResolution
        };
    }

    private static object Finish(ILLMContextPolymorphicArray owner, Fixture fixture, bool partitioned,
        Traffic traffic, Worker[] workers)
    {
        if (traffic.Errors.TryDequeue(out var error)) throw new InvalidOperationException("Worker failed.", error);
        long quiescentSynchronization = 0, quiescentOracle = 0;
        foreach (var session in fixture.Sessions)
        {
            if (partitioned)
            {
                long start = Now;
                CheckSync(owner.SynchronizeIndexAsync(session.SessionId).GetAwaiter().GetResult());
                quiescentSynchronization += Now - start;
            }
            long oracleStart = Now;
            Verify(owner, session.SessionId, fixture.Entries * 2, Shared);
            Verify(owner, session.SessionId, fixture.Entries * 2, StateOne);
            quiescentOracle += Now - oracleStart;
            traffic.OracleChecks += 2;
        }
        var statistics = owner.GetStatistics();
        if (statistics.RetainedReads != 0 || statistics.EstimatedRetainedBytes != 0 ||
            statistics.EstimatedPreparationBytes != 0 || statistics.PendingSynchronizations != 0)
            throw new InvalidOperationException("Owner reservations did not recover.");
        long applied = workers.Sum(worker => worker.Applied);
        long revisions = fixture.Sessions.Sum(session => Revision(owner, session.SessionId));
        if (applied != revisions) throw new InvalidOperationException("Accepted writes disagree with final revisions.");
        var apply = new Histogram();
        var endToEnd = new Histogram();
        var queue = new Histogram();
        var statuses = new long[Enum.GetValues<ContextMutationStatus>().Length];
        foreach (var worker in workers)
        {
            apply.Merge(worker.Apply);
            endToEnd.Merge(worker.EndToEnd);
            queue.Merge(worker.Queue);
            for (int i = 0; i < statuses.Length; i++) statuses[i] += worker.Statuses[i];
        }
        long attempts = workers.Sum(worker => worker.Attempts);
        if (statuses.Sum() != attempts || traffic.Offered != attempts + traffic.Dropped)
            throw new InvalidOperationException("Request terminal accounting mismatch.");
        if (statuses[(int)ContextMutationStatus.InvalidOperation] != 0 ||
            statuses[(int)ContextMutationStatus.NotFound] != 0)
            throw new InvalidOperationException("Unexpected validation/missing-session failure.");
        return new
        {
            Attempts = attempts,
            Applied = applied,
            Statuses = statuses,
            Apply = apply,
            EndToEnd = endToEnd,
            Queue = queue,
            AppliedSameState = workers.Sum(worker => worker.AppliedSameState),
            AttemptsBySecond = Enumerable.Range(0, (int)Math.Ceiling((traffic.Deadline - traffic.Start) /
                (double)Stopwatch.Frequency)).Select(i => workers.Sum(worker => worker.AttemptsBySecond[i])).ToArray(),
            AppliedBySecond = Enumerable.Range(0, (int)Math.Ceiling((traffic.Deadline - traffic.Start) /
                (double)Stopwatch.Frequency)).Select(i => workers.Sum(worker => worker.AppliedBySecond[i])).ToArray(),
            RejectedBeforeApply = attempts - apply.Count,
            Query = traffic.Search,
            Synchronization = traffic.Synchronization,
            QuiescentSynchronizationTicks = quiescentSynchronization,
            QuiescentOracleTicks = quiescentOracle,
            traffic.Queries,
            traffic.OracleChecks,
            traffic.SyncRequests,
            traffic.SyncFailures,
            Workers = workers.Select((worker, i) => new
            {
                Id = i,
                worker.Attempts,
                worker.Applied,
                worker.AppliedSameState,
                FirstAttemptOffsetTicks = worker.Attempts == 0 ? -1 : worker.FirstAttempt - traffic.Start,
                LastAttemptOffsetTicks = worker.Attempts == 0 ? -1 : worker.LastAttempt - traffic.Start
            }).ToArray(),
            FinalStatistics = statistics
        };
    }

    private static object Threads(bool partitioned, int position, int writerCount, int sessions)
    {
        var fixture = new Fixture(sessions, 4, 4, 8);
        using var owner = fixture.Open(partitioned);
        var traffic = new Traffic();
        var workers = Enumerable.Range(0, writerCount).Select(_ => new Worker()).ToArray();
        using var ready = new CountdownEvent(writerCount);
        using var go = new ManualResetEventSlim();
        var threads = new List<Thread>();
        long creationStart = Now;
        using var telemetry = new Telemetry();
        try
        {
            for (int i = 0; i < writerCount; i++)
            {
                if (telemetry.LimitExceeded) throw new InvalidOperationException("Writer startup exceeded process memory limit.");
                int writer = i;
                var thread = new Thread(() =>
                {
                    ready.Signal();
                    go.Wait();
                    try
                    {
                        WaitUntil(traffic.Start);
                        int iteration = 0;
                        while (!traffic.Stop && Now < traffic.Deadline && !telemetry.LimitExceeded)
                        {
                            int sequence = sessions == 1 ? writer + iteration * writerCount :
                                writer + iteration * sessions;
                            Attempt(owner, fixture, workers[writer], traffic, sequence, Now, writer % sessions);
                            iteration++;
                            Thread.Sleep(10);
                        }
                    }
                    catch (Exception error) { traffic.Errors.Enqueue(error); traffic.Stop = true; }
                }, 256 * 1024)
                { IsBackground = true, Name = $"PartitionStressWriter{i}" };
                thread.Start();
                threads.Add(thread);
            }
            if (!ready.Wait(TimeSpan.FromSeconds(30))) throw new TimeoutException("Dedicated writer startup timed out.");
            long creationTicks = Now - creationStart;
            int readyWriters = threads.Count(thread => thread.IsAlive);
            traffic.Start = Now + Ticks(0.2);
            traffic.Deadline = traffic.Start + Ticks(2);
            var auxiliary = StartAuxiliary(owner, fixture, partitioned, traffic);
            go.Set();
            WaitUntil(traffic.Deadline);
            foreach (var thread in threads) thread.Join();
            traffic.Stop = true;
            auxiliary.Query.Join();
            auxiliary.Maintenance?.Join();
            long drained = Now;
            telemetry.Dispose();
            traffic.Offered = workers.Sum(worker => worker.Attempts);
            var terminal = Finish(owner, fixture, partitioned, traffic, workers);
            if (readyWriters != writerCount) throw new InvalidOperationException("Not all dedicated writers were alive.");
            return new
            {
                Suite = "Threads",
                Name = $"{writerCount}writers-{sessions}s",
                Policy = Policy(partitioned),
                Position = position,
                Sessions = sessions,
                Writers = writerCount,
                ReadyWriters = readyWriters,
                RequestedStackBytes = 256 * 1024,
                CreationTicks = creationTicks,
                WindowTicks = Ticks(2),
                DrainTicks = Math.Max(0, drained - traffic.Deadline),
                traffic.Offered,
                traffic.Dropped,
                traffic.PeakInApply,
                Terminal = terminal,
                Telemetry = telemetry.Result()
            };
        }
        finally
        {
            traffic.Stop = true;
            go.Set();
            foreach (var thread in threads) thread.Join();
        }
    }

    private static object Heap(bool partitioned, int position, bool distinct, bool pinned)
    {
        var fixture = new Fixture(1, 256, 16, 512, distinct);
        Collect();
        long producerBaseline = GC.GetTotalMemory(false);
        using var owner = fixture.Open(partitioned);
        using var retainedRead = pinned ? owner.OpenRead(Id(1)) : null;
        ILLMContextReadLease? old = retainedRead;
        Collect();
        long initial = GC.GetTotalMemory(false);
        using var telemetry = new Telemetry();
        var phases = new List<object>();
        long revision = 0;
        for (int n = 0; n < 256; n++)
        {
            if (n % 16 == 15) continue;
            Check(owner.Apply(new(Id(1), revision++, [new DeleteEntry(Id(10000 + n))])));
        }
        phases.Add(new
        {
            Phase = "Shrunk",
            OffsetTicks = telemetry.ElapsedTicks,
            ManagedBytes = GC.GetTotalMemory(false),
            Statistics = owner.GetStatistics()
        });
        if (partitioned) CheckSync(owner.SynchronizeIndexAsync(Id(1)).GetAwaiter().GetResult());
        phases.Add(new
        {
            Phase = "SynchronizedShrink",
            OffsetTicks = telemetry.ElapsedTicks,
            ManagedBytes = GC.GetTotalMemory(false),
            Statistics = owner.GetStatistics()
        });
        for (int n = 256; n < 496; n++)
        {
            Check(owner.Apply(new(Id(1), revision++, [new AppendEntries([new(
                Id(10000 + n), ContextRole.User, DateTimeOffset.UnixEpoch, new TextContent("v:1"))
            { IndexKeys = fixture.Keys[n, 1] }])])));
        }
        if (partitioned) CheckSync(owner.SynchronizeIndexAsync(Id(1)).GetAwaiter().GetResult());
        phases.Add(new
        {
            Phase = "SynchronizedGrowth",
            OffsetTicks = telemetry.ElapsedTicks,
            ManagedBytes = GC.GetTotalMemory(false),
            Statistics = owner.GetStatistics()
        });
        telemetry.Dispose();
        Verify(owner, Id(1), 512, Shared);
        Verify(owner, Id(1), 512, StateOne);
        if (old is not null && old.SearchKeys(Shared, 512).Length != 256)
            throw new InvalidOperationException("Pinned initial index changed.");
        Collect();
        long beforeRelease = GC.GetTotalMemory(false);
        long retained = owner.GetStatistics().EstimatedRetainedBytes;
        old?.Dispose();
        old = null;
        Collect();
        long afterRelease = GC.GetTotalMemory(false);
        var statistics = owner.GetStatistics();
        if (statistics.EstimatedRetainedBytes != 0 || statistics.EstimatedPreparationBytes != 0)
            throw new InvalidOperationException("Heap lifecycle reservations leaked.");
        GC.KeepAlive(fixture);
        return new
        {
            Suite = "Heap",
            Name = $"{(distinct ? "distinct" : "common")}-{pinned}",
            Policy = Policy(partitioned),
            Position = position,
            Pinned = pinned,
            Distinct = distinct,
            ProducerBaselineManagedBytes = producerBaseline,
            InitialManagedBytes = initial,
            BeforeReleaseCollectedManagedBytes = beforeRelease,
            AfterReleaseCollectedManagedBytes = afterRelease,
            RetainedBytesBeforeRelease = retained,
            FinalStatistics = statistics,
            Phases = phases,
            Telemetry = telemetry.Result(),
            Mutations = revision
        };
    }

    private static object Scaling(bool partitioned, int position, int partitions)
    {
        var fixture = new Fixture(1, partitions * 8, 8, 8);
        using var owner = fixture.Open(partitioned);
        int changes = Math.Min(256, fixture.Entries);
        var apply = new Histogram();
        using var telemetry = new Telemetry();
        for (int n = 0; n < changes; n++)
        {
            int entry = n * (fixture.Entries / changes);
            long start = Now;
            Check(owner.Apply(new(Id(1), n, [new ReplaceEntry(Id(10000 + entry), new TextContent("v:1"))
            { IndexKeys = fixture.Keys[entry, 1] }])));
            apply.Add(Now - start);
        }
        long sync = Now;
        if (partitioned) CheckSync(owner.SynchronizeIndexAsync(Id(1)).GetAwaiter().GetResult());
        sync = partitioned ? Now - sync : 0;
        var common = new Histogram();
        var point = new Histogram();
        var pointQuery = new ContextIndexKeys([$"entry:{fixture.Entries - 1}"]);
        for (int i = 0; i < 144; i++)
        {
            MeasureQuery(Shared, i < 16 ? null : common);
            MeasureQuery(pointQuery, i < 16 ? null : point);
        }
        telemetry.Dispose();
        Verify(owner, Id(1), fixture.Entries * 2, Shared);
        Verify(owner, Id(1), fixture.Entries * 2, StateOne);
        if (owner.GetStatistics().RetainedReads != 0) throw new InvalidOperationException("Scaling read leaked.");
        return new
        {
            Suite = "Scaling",
            Name = $"{partitions}partitions",
            Policy = Policy(partitioned),
            Position = position,
            Partitions = partitions,
            fixture.Entries,
            Apply = apply,
            SynchronizationTicks = sync,
            CommonQuery = common,
            PointQuery = point,
            OracleChecks = 290,
            FinalStatistics = owner.GetStatistics(),
            Telemetry = telemetry.Result()
        };

        void MeasureQuery(ContextIndexKeys query, Histogram? histogram)
        {
            owner.WithCurrent(Id(1), read =>
            {
                long start = Now;
                var actual = read.SearchKeys(query, 16);
                histogram?.Add(Now - start);
                var expected = Enumerable.Range(0, fixture.Entries)
                    .Where(n => query.Keys.All(key => fixture.Keys[n, n % (fixture.Entries / changes) == 0 &&
                        n / (fixture.Entries / changes) < changes ? 1 : 0].Keys.Contains(key)))
                    .Take(16).Select(n => Id(10000 + n));
                if (!expected.SequenceEqual(actual.Select(hit => hit.EntryId)))
                    throw new InvalidOperationException("Scaling query oracle mismatch.");
            });
        }
    }
}
