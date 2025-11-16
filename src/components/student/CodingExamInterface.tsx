
'use client';

import { useEffect, useReducer, useState, useCallback, useMemo } from 'react';
import type { Exam, StudentAnswer, StudentExam, UserProfile } from '@/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Check, ChevronLeft, ChevronRight, Flag, Loader2, Play, AlertTriangle, ShieldAlert, Trash2, Monitor, MonitorOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { QuestionStatus, Question, TestResult } from '@/types';
import { useToast } from '@/hooks/use-toast';
import { useRouter } from 'next/navigation';
import { doc, getDoc, serverTimestamp, Timestamp } from 'firebase/firestore';
import { useFirestore, useUser, setDocumentNonBlocking, useDoc, useMemoFirebase } from '@/firebase';
import { useFullscreenEnforcement } from '@/hooks/use-fullscreen-enforcement';
import Editor from "@monaco-editor/react";
import { executeCode, type ExecuteCodeOutput } from '@/ai/flows/execute-code-flow';
import { Separator } from '../ui/separator';
import { Skeleton } from '../ui/skeleton';
import { Avatar, AvatarFallback } from '../ui/avatar';
import { Tooltip, TooltipProvider, TooltipContent, TooltipTrigger } from '../ui/tooltip';


type AnswerPayload = 
  | { type: 'coding', questionId: string; sourceCode: string };

// --- State Management ---
type State = {
  currentQuestionIndex: number;
  answers: Map<string, any>; // Stores source code for coding
  statuses: Map<string, QuestionStatus>;
  executionResults: Map<string, ExecuteCodeOutput>; // Map questionId to full execution result
  isExecuting: Map<string, boolean>; // Map questionId to execution status
  timeLeft: number;
  examStarted: boolean;
  examFinished: boolean;
  totalQuestions: number;
};

type Action =
  | { type: 'INITIALIZE'; payload: State }
  | { type: 'START_EXAM' }
  | { type: 'NEXT_QUESTION' }
  | { type: 'PREV_QUESTION' }
  | { type: 'JUMP_TO_QUESTION'; payload: number }
  | { type: 'ANSWER'; payload: AnswerPayload }
  | { type: 'CLEAR_ANSWER'; payload: string }
  | { type: 'TOGGLE_MARK_FOR_REVIEW'; payload: string }
  | { type: 'TICK_TIMER' }
  | { type: 'FINISH_EXAM' }
  | { type: 'SET_EXECUTING'; payload: { questionId: string; isExecuting: boolean } }
  | { type: 'SET_EXECUTION_RESULT'; payload: { questionId: string; result: ExecuteCodeOutput } };

function examReducer(state: State, action: Action): State {
  switch (action.type) {
    case 'INITIALIZE':
      return action.payload;
    case 'START_EXAM': {
        if (!state.statuses.size) return { ...state, examStarted: true };
        const firstQuestionId = Array.from(state.statuses.keys())[0];
        const newStatuses = new Map(state.statuses);
        if (newStatuses.get(firstQuestionId) === 'not-visited') {
            newStatuses.set(firstQuestionId, 'not-answered');
        }
        return { ...state, examStarted: true, statuses: newStatuses };
    }
    case 'NEXT_QUESTION': {
      const nextIndex = Math.min(state.currentQuestionIndex + 1, state.totalQuestions - 1);
      const questionId = Array.from(state.statuses.keys())[nextIndex];
      const newStatuses = new Map(state.statuses);
      if (newStatuses.get(questionId) === 'not-visited') {
        newStatuses.set(questionId, 'not-answered');
      }
      return { ...state, currentQuestionIndex: nextIndex, statuses: newStatuses };
    }
    case 'PREV_QUESTION': {
      const prevIndex = Math.max(state.currentQuestionIndex - 1, 0);
      return { ...state, currentQuestionIndex: prevIndex };
    }
    case 'JUMP_TO_QUESTION': {
      const questionId = Array.from(state.statuses.keys())[action.payload];
      const newStatuses = new Map(state.statuses);
      if (newStatuses.get(questionId) === 'not-visited') {
        newStatuses.set(questionId, 'not-answered');
      }
      return { ...state, currentQuestionIndex: action.payload, statuses: newStatuses };
    }
    case 'ANSWER': {
      const newAnswers = new Map(state.answers);
      const { payload } = action;
      newAnswers.set(payload.questionId, payload.sourceCode);

      const newStatuses = new Map(state.statuses);
      if (newStatuses.get(payload.questionId) !== 'marked-for-review') {
        newStatuses.set(payload.questionId, 'answered');
      }
      return { ...state, answers: newAnswers, statuses: newStatuses };
    }
     case 'CLEAR_ANSWER': {
      const newAnswers = new Map(state.answers);
      newAnswers.set(action.payload, null);

      const newStatuses = new Map(state.statuses);
      if (newStatuses.get(action.payload) !== 'marked-for-review') {
        newStatuses.set(action.payload, 'not-answered');
      }
      return { ...state, answers: newAnswers, statuses: newStatuses };
    }
    case 'TOGGLE_MARK_FOR_REVIEW': {
      const newStatuses = new Map(state.statuses);
      const currentStatus = state.statuses.get(action.payload);
      if (currentStatus === 'marked-for-review') {
        newStatuses.set(action.payload, state.answers.get(action.payload) != null ? 'answered' : 'not-answered');
      } else {
        newStatuses.set(action.payload, 'marked-for-review');
      }
      return { ...state, statuses: newStatuses };
    }
    case 'TICK_TIMER':
      if (state.timeLeft <= 1) {
        return { ...state, timeLeft: 0, examFinished: true };
      }
      return { ...state, timeLeft: state.timeLeft - 1 };
    case 'FINISH_EXAM':
      return { ...state, examFinished: true, timeLeft: 0 };
    case 'SET_EXECUTING':
      const newExecuting = new Map(state.isExecuting);
      newExecuting.set(action.payload.questionId, action.payload.isExecuting);
      return { ...state, isExecuting: newExecuting };
    case 'SET_EXECUTION_RESULT':
      const newExecutionResults = new Map(state.executionResults);
      newExecutionResults.set(action.payload.questionId, action.payload.result);
      return { ...state, executionResults: newExecutionResults };
    default:
      return state;
  }
}

const StudentDetailsCard = ({ profile, isLoading }: { profile: UserProfile | null, isLoading: boolean }) => {
  const getInitials = (name: string | undefined) => {
    if (!name) return 'S';
    return name.split(' ').map(n => n[0]).join('').toUpperCase();
  }

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Student Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3">
            <Skeleton className="h-10 w-10 rounded-full" />
            <div className="space-y-1">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-40" />
            </div>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (!profile) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Student Details</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-4">
          <Avatar className="h-12 w-12">
            <AvatarFallback>{getInitials(profile.name)}</AvatarFallback>
          </Avatar>
          <div>
            <p className="font-semibold text-lg">{profile.name}</p>
            <p className="text-sm text-muted-foreground">{profile.email}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
};


const QuestionPalette = ({ statuses, currentIndex, dispatch }: { statuses: Map<string, QuestionStatus>, currentIndex: number, dispatch: React.Dispatch<Action> }) => {
    const statusArray = Array.from(statuses.entries());
    return (
        <Card>
            <CardHeader><CardTitle>Question Palette</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-5 gap-2">
                {statusArray.map(([questionId, status], index) => (
                    <Button
                        key={questionId}
                        variant={currentIndex === index ? 'default' : 'outline'}
                        className={cn('h-10 w-10 relative', {
                            'bg-green-100 border-green-400 text-green-800 hover:bg-green-200': status === 'answered' && currentIndex !== index,
                            'bg-purple-100 border-purple-400 text-purple-800 hover:bg-purple-200': status === 'marked-for-review' && currentIndex !== index,
                            'bg-gray-100 border-gray-400 text-gray-800 hover:bg-gray-200': status === 'not-answered' && currentIndex !== index,
                            'bg-white border-gray-300 text-gray-600': status === 'not-visited' && currentIndex !== index,
                        })}
                        onClick={() => dispatch({ type: 'JUMP_TO_QUESTION', payload: index })}
                    >
                        {index + 1}
                        {status === 'marked-for-review' && <Flag className="absolute top-0 right-0 h-3 w-3 text-purple-600" fill="currentColor" />}
                        {status === 'answered' && <Check className="absolute bottom-0 right-0 h-3 w-3 text-green-600" />}
                    </Button>
                ))}
            </CardContent>
        </Card>
    );
};


const ExamTimer = ({ timeLeft }: { timeLeft: number }) => {
  const minutes = Math.floor(timeLeft / 60);
  const seconds = timeLeft % 60;
  return (
    <div className={cn("text-xl font-bold font-mono", timeLeft < 300 && 'text-destructive')}>
      {String(minutes).padStart(2, '0')}:{String(seconds).padStart(2, '0')}
    </div>
  );
};

const FullscreenStatus = ({ isFullscreen, isPageVisible, exitCount, maxExits, countdown }: { isFullscreen: boolean, isPageVisible: boolean, exitCount: number, maxExits: number, countdown: number | null}) => {
  const warningsLeft = maxExits - exitCount;
  const isSecure = isFullscreen && isPageVisible;
  return (
    <Card>
      <CardContent className="p-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
            {isSecure ? <Monitor className="h-5 w-5 text-green-600" /> : <MonitorOff className="h-5 w-5 text-destructive" />}
            <span className={cn("font-semibold", isSecure ? "text-green-700" : "text-destructive")}>
                {isSecure ? "Secure Mode Active" : "Insecure Mode"}
            </span>
        </div>
        <div className="text-right">
            <p className="text-sm font-medium">Warnings: <span className={cn(warningsLeft <= 1 && "text-destructive font-bold")}>{exitCount}/{maxExits}</span></p>
            {countdown !== null && <p className="text-xs text-destructive animate-pulse font-bold">Auto-submit in {countdown}s</p>}
        </div>
      </CardContent>
    </Card>
  );
};

const TestCaseResult = ({ result }: { result: TestResult }) => (
    <div className={cn(
        "p-3 rounded-md border text-sm",
        result.isCorrect ? "bg-green-50 border-green-200" : "bg-red-50 border-red-200"
    )}>
        <div className="flex justify-between items-center font-semibold">
            <span className={cn(result.isCorrect ? "text-green-700" : "text-red-700")}>
                {result.isCorrect ? "Test Case Passed" : "Test Case Failed"}
            </span>
            <span>{result.isCorrect ? <Check className="h-5 w-5 text-green-600" /> : <AlertTriangle className="h-5 w-5 text-red-600" />}</span>
        </div>
        <Separator className="my-2" />
        <div className="space-y-2 font-mono text-xs">
            <p><span className="font-semibold">Input:</span> {result.input}</p>
            <p><span className="font-semibold">Expected:</span> {result.expectedOutput}</p>
            <p><span className="font-semibold">Got:</span> {result.actualOutput}</p>
            {result.error && <p className="text-red-600"><span className="font-semibold">Error:</span> {result.error}</p>}
        </div>
    </div>
);


export function CodingExamInterface({ examId }: { examId: string }) {
  const { toast } = useToast();
  const router = useRouter();
  const { user } = useUser();
  const firestore = useFirestore();

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [isUserLoading, setIsUserLoading] = useState(true);

  const examDocRef = useMemoFirebase(() => doc(firestore, 'exams', examId), [firestore, examId]);
  const { data: examData, isLoading: isExamLoading } = useDoc<Exam>(examDocRef);
  
  const studentExamDocRef = useMemoFirebase(() => {
    if (!user) return null;
    return doc(firestore, 'studentExams', `${user.uid}_${examId}`);
  }, [firestore, examId, user]);
  const { data: studentExamData, isLoading: isStudentExamLoading } = useDoc<StudentExam>(studentExamDocRef);

  const shuffledQuestions = useMemo(() => {
    if (!examData?.questions) return [];
    const array = [...examData.questions];
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }, [examData?.questions]);

  useEffect(() => {
    const fetchProfile = async () => {
      setIsUserLoading(true);
      if (user) {
        const userDocRef = doc(firestore, 'users', user.uid);
        try {
          const userDoc = await getDoc(userDocRef);
          if (userDoc.exists()) {
            setUserProfile(userDoc.data() as UserProfile);
          }
        } catch (error) {
          console.error("Error fetching user profile:", error);
          toast({ variant: "destructive", title: "Could not load user details." });
        }
      }
      setIsUserLoading(false);
    };

    fetchProfile();
  }, [user, firestore, toast]);

  const initialState: State | null = useMemo(() => {
    if (!examData) return null;
    return {
      currentQuestionIndex: 0,
      answers: new Map(),
      statuses: new Map(shuffledQuestions.map(q => [q.id, 'not-visited'])),
      executionResults: new Map(),
      isExecuting: new Map(),
      timeLeft: examData.duration * 60,
      examStarted: false,
      examFinished: false,
      totalQuestions: shuffledQuestions.length,
    };
  }, [examData, shuffledQuestions]);

  const [state, dispatch] = useReducer(examReducer, initialState as State);

  useEffect(() => {
    if (initialState) {
      dispatch({ type: 'INITIALIZE', payload: initialState });
    }
  }, [initialState]);

  const handleRunCode = useCallback(async (question: Question) => {
    if (!state) return;
    const sourceCode = state.answers.get(question.id);
    if (!sourceCode || !examData?.language) {
        toast({ variant: "destructive", title: "Cannot run code", description: "Source code or language are missing." });
        return;
    }

    dispatch({ type: 'SET_EXECUTING', payload: { questionId: question.id, isExecuting: true } });
    try {
        const result = await executeCode({
            sourceCode,
            language: examData.language,
            testCases: question.testCases,
        });
        dispatch({ type: 'SET_EXECUTION_RESULT', payload: { questionId: question.id, result: result } });
    } catch (error: any) {
        toast({ variant: "destructive", title: "Execution Failed", description: error.message });
    } finally {
        dispatch({ type: 'SET_EXECUTING', payload: { questionId: question.id, isExecuting: false } });
    }
  }, [state, examData?.language, toast]);


  const handleSubmitExam = useCallback(async (autoSubmitDetails?: { autoSubmitted: boolean; exitCount: number }) => {
    if (!state || !user || !examData || isSubmitting || !studentExamDocRef) return;
  
    setIsSubmitting(true);
    toast({ title: "Submitting exam...", description: "Please wait while we process your submission." });
  
    const studentAnswers: StudentAnswer[] = [];
    
    for (const q of shuffledQuestions) {
        const sourceCode = state.answers.get(q.id) || "";
        let answerPayload: Partial<StudentAnswer> = {
            questionId: q.id,
            questionText: q.text,
            sourceCode: sourceCode,
            status: state.statuses.get(q.id) || 'not-visited',
        };

        if (sourceCode && examData.language && q.testCases && q.testCases.length > 0) {
            try {
                const result = await executeCode({
                    sourceCode,
                    language: examData.language,
                    testCases: q.testCases,
                });
                answerPayload = {
                    ...answerPayload,
                    testResults: result.results,
                    totalPassed: result.totalPassed,
                    totalCases: result.totalCases,
                    marks: (result.totalPassed / result.totalCases) * 100,
                    rawOutput: result.rawOutput,
                    rawError: result.rawError
                };
            } catch (error: any) {
                console.error(`Execution failed for question ${q.id} on final submit:`, error);
                answerPayload = {
                    ...answerPayload,
                    error: `Execution failed during final submission: ${error.message}`,
                    marks: 0,
                };
            }
        } else {
             answerPayload.marks = 0; // No code or no test cases, no marks
        }
        studentAnswers.push(answerPayload as StudentAnswer);
    }
    
    const totalMarks = studentAnswers.reduce((acc, ans) => acc + (ans.marks || 0), 0);
    const finalScore = studentAnswers.length > 0 ? totalMarks / studentAnswers.length : 0;
    
    const submissionPayload: Partial<StudentExam> = {
      studentId: user.uid,
      examId: examId,
      examTitle: examData.title,
      answers: studentAnswers,
      score: finalScore,
      timeFinished: serverTimestamp(),
      status: 'graded',
      language: examData.language,
      ...autoSubmitDetails,
    };
    
    if (autoSubmitDetails) {
        submissionPayload.status = 'suspicious';
    }
    
    Object.keys(submissionPayload).forEach(key => {
        if (submissionPayload[key as keyof typeof submissionPayload] === undefined) {
            delete submissionPayload[key as keyof typeof submissionPayload];
        }
    });
  
    try {
      setDocumentNonBlocking(studentExamDocRef, submissionPayload, { merge: true });
      dispatch({ type: 'FINISH_EXAM' });
  
      toast({
        title: "Exam Submitted!",
        description: `Your exam has been automatically graded.`,
      });
      router.push('/student/dashboard');
  
    } catch (error) {
      console.error("Submission failed", error);
      toast({ variant: 'destructive', title: 'Submission Failed' });
      setIsSubmitting(false);
    }
  }, [state, user, examData, examId, isSubmitting, toast, studentExamDocRef, router, shuffledQuestions]);

    const handleAutoSubmit = useCallback(() => {
        const exitCount = parseInt(localStorage.getItem(`fullscreenExitCount_${examId}`) || '0', 10);
        handleSubmitExam({ autoSubmitted: true, exitCount: exitCount });
    }, [examId, handleSubmitExam]);

  const { isFullscreen, isPageVisible, exitCount, MAX_EXITS, enterFullscreen, countdown } = useFullscreenEnforcement(
      examId,
      handleAutoSubmit,
      state?.examStarted,
      state?.examFinished
    );
  
    useEffect(() => {
        if (!state || !state.examStarted || state.examFinished) return;
        const timer = setInterval(() => dispatch({ type: 'TICK_TIMER' }), 1000);
        return () => clearInterval(timer);
    }, [state?.examStarted, state?.examFinished]);

    useEffect(() => {
        if (state?.timeLeft === 0 && state.examStarted && !state.examFinished && !isSubmitting) {
            handleAutoSubmit();
        }
    }, [state?.timeLeft, state?.examStarted, state?.examFinished, handleAutoSubmit, isSubmitting]);

    useEffect(() => {
        const header = document.querySelector('.exam-layout-header');
        if (state?.examStarted && !state.examFinished) {
            header?.classList.add('hidden');
        }
        return () => {
            header?.classList.remove('hidden');
        }
    }, [state?.examStarted, state?.examFinished]);
    
    function handleEditorDidMount(editor: any, monaco: any) {
        editor.addAction({
            id: 'disable-paste',
            label: 'Disable Paste',
            keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyV],
            run: () => {}
        });
    }

  const isLoading = isExamLoading || isStudentExamLoading || isUserLoading;
  
  if (isLoading) {
    return (
      <div className="flex h-screen w-full flex-col items-center justify-center bg-background">
        <Loader2 className="h-12 w-12 animate-spin text-primary" />
        <p className="mt-4 text-muted-foreground">Loading Exam...</p>
      </div>
    );
  }
  
  if (!examData || !state) {
    return (
        <div className="flex h-screen w-full flex-col items-center justify-center bg-background text-center">
            <h2 className="text-2xl font-bold">Exam Not Found</h2>
            <p className="mt-2 text-muted-foreground">The exam you are looking for does not exist or has been removed.</p>
        </div>
    );
  }

  if (studentExamData) {
    return (
      <div className="flex h-screen w-full flex-col items-center justify-center bg-background text-center p-4">
        <ShieldAlert className="h-16 w-16 text-destructive mb-4" />
        <h2 className="text-2xl font-bold">Exam Already Completed</h2>
        <p className="mt-2 text-muted-foreground max-w-md">
          You have already submitted this exam. You cannot take it again.
        </p>
        <Button onClick={() => router.push('/student/dashboard')} className="mt-6">
          Return to Dashboard
        </Button>
      </div>
    );
  }

  const elapsedTime = examData.duration * 60 - state.timeLeft;
  const minimumTimeInSeconds = (examData.minimumTime ?? examData.duration * 0.5) * 60;
  const isSubmitDisabled = elapsedTime < minimumTimeInSeconds;
  
  const submitButtonTooltip = isSubmitDisabled
    ? `You can submit after ${Math.ceil((minimumTimeInSeconds - elapsedTime) / 60)} more minutes.`
    : "You can now submit the exam.";


  if (!state.examStarted) {
      return (
          <div className="container flex items-center justify-center min-h-[calc(100vh-4rem)]">
            <Card className="w-full max-w-2xl text-center">
                <CardHeader>
                    <CardTitle className="text-3xl">{examData.title}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <p>{examData.description}</p>
                    <div className="flex justify-center gap-8 text-lg">
                        <p><strong>Duration:</strong> {examData.duration} minutes</p>
                         {examData.minimumTime && <p><strong>Min. Time:</strong> {examData.minimumTime} minutes</p>}
                    </div>
                    <p className="text-sm text-muted-foreground">This exam will be conducted in fullscreen mode.</p>
                    <Button size="lg" onClick={() => {
                        enterFullscreen();
                        dispatch({type: 'START_EXAM'});
                    }}>Start Exam</Button>
                </CardContent>
            </Card>
          </div>
      );
  }

    if (state.examStarted && (!isFullscreen || !isPageVisible)) {
        return (
        <div className="flex h-screen w-full flex-col items-center justify-center bg-background text-center p-4">
            <AlertTriangle className="h-16 w-16 text-destructive mb-4" />
            <h2 className="text-2xl font-bold">You have left the secure exam environment.</h2>
            <p className="mt-2 text-muted-foreground max-w-md">
                To continue the exam, you must return to full-screen.
            </p>
            <p className="font-bold text-lg mt-4">
            Warnings used: <span className="text-destructive">{exitCount} / {MAX_EXITS}</span>
            </p>
             {countdown !== null && <p className="text-xl text-destructive animate-pulse font-bold mt-2">Auto-submit in {countdown} seconds</p>}
            <Button onClick={enterFullscreen} size="lg" className="mt-6">
            Return to Exam
            </Button>
        </div>
        );
    }
  
    if (state.examFinished) {
        return (
            <div className="flex h-screen w-full flex-col items-center justify-center bg-background">
                <Loader2 className="h-12 w-12 animate-spin text-primary" />
                <p className="mt-4 text-muted-foreground">{isSubmitting ? "Submitting your exam..." : "Exam Finished!"}</p>
            </div>
        );
    }

    const currentQuestion = shuffledQuestions[state.currentQuestionIndex];
    const isExecuting = state.isExecuting.get(currentQuestion.id) || false;
    const currentExecutionResult = state.executionResults.get(currentQuestion.id);

  return (
    <div className="grid lg:grid-cols-12 gap-8 p-8 h-screen bg-muted/20">
      <div className="lg:col-span-8 flex flex-col justify-between">
        <div>
          <h2 className="text-xl font-semibold mb-2">Question {state.currentQuestionIndex + 1} of {state.totalQuestions}</h2>
          <Card>
            <CardContent className="p-6">
                <div className="flex-1">
                     <Editor
                        height="40vh"
                        language={examData.language}
                        theme="vs-dark"
                        value={state.answers.get(currentQuestion.id) || ''}
                        onChange={(value) => dispatch({ type: 'ANSWER', payload: { type: 'coding', questionId: currentQuestion.id, sourceCode: value || '' }})}
                        onMount={handleEditorDidMount}
                        options={{
                            minimap: { enabled: false },
                            fontSize: 14,
                        }}
                    />
                </div>
            </CardContent>
          </Card>
           <div className="mt-4">
            <h3 className="text-md font-semibold">Console</h3>
                <div className="p-3 bg-gray-800 text-white rounded-md mt-2 font-mono text-sm h-48 overflow-y-auto">
                    {currentExecutionResult?.rawOutput && (
                        <div>
                            <h4 className="font-semibold text-sm text-gray-400">Output:</h4>
                            <pre className="whitespace-pre-wrap">{currentExecutionResult.rawOutput}</pre>
                        </div>
                    )}
                     {currentExecutionResult?.rawError && (
                        <div>
                            <h4 className="font-semibold text-sm text-red-400">Error:</h4>
                            <pre className="text-red-400 whitespace-pre-wrap">{currentExecutionResult.rawError}</pre>
                        </div>
                    )}
                    {currentExecutionResult?.results?.map((result, idx) => (
                        <TestCaseResult key={idx} result={result} />
                    ))}
                    {!currentExecutionResult && <p className="text-xs text-gray-500">Run your code to see the output here.</p>}
                </div>
           </div>
        </div>
        <div className="flex justify-between items-center mt-6">
            <Button variant="outline" onClick={() => dispatch({ type: 'PREV_QUESTION' })} disabled={state.currentQuestionIndex === 0}>
                <ChevronLeft className="mr-2 h-4 w-4" /> Previous
            </Button>
            <div className='flex gap-2'>
                <Button variant="ghost" onClick={() => dispatch({ type: 'CLEAR_ANSWER', payload: currentQuestion.id })}>
                    <Trash2 className="mr-2 h-4 w-4" /> Clear Response
                </Button>
                <Button variant="outline" onClick={() => dispatch({ type: 'TOGGLE_MARK_FOR_REVIEW', payload: currentQuestion.id })}>
                    <Flag className="mr-2 h-4 w-4" /> Mark for Review
                </Button>
                 <Button onClick={() => handleRunCode(currentQuestion)} disabled={isExecuting} size="sm">
                    {isExecuting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                    Run Code
                </Button>
            </div>
            <Button onClick={() => dispatch({ type: 'NEXT_QUESTION' })} disabled={state.currentQuestionIndex === state.totalQuestions - 1}>
                Next <ChevronRight className="ml-2 h-4 w-4" />
            </Button>
        </div>
      </div>
      
      <div className="lg:col-span-4 flex flex-col gap-8 overflow-y-auto">
        <Card>
            <CardHeader className="flex-row items-center justify-between">
                <CardTitle>Time Left</CardTitle>
                <ExamTimer timeLeft={state.timeLeft} />
            </CardHeader>
        </Card>

        <StudentDetailsCard profile={userProfile} isLoading={isUserLoading} />
        
        <FullscreenStatus 
            isFullscreen={isFullscreen}
            isPageVisible={isPageVisible} 
            exitCount={exitCount} 
            maxExits={MAX_EXITS} 
            countdown={countdown}
        />

        <div className='flex-1'>
            <h3 className="font-semibold mb-2">Problem Description</h3>
            <p className="text-sm mb-4">{currentQuestion.text}</p>
            <Separator />
            <h3 className="text-md font-semibold my-2">Test Cases</h3>
            <div className="space-y-2 text-sm">
                {currentQuestion.testCases && currentQuestion.testCases.length > 0 ? (
                    currentQuestion.testCases?.map((tc, idx) => (
                        <div key={tc.id} className="p-2 bg-muted rounded-md">
                            <p className="font-semibold">Example {idx + 1}</p>
                            <p className="font-mono text-xs"><strong>Input:</strong> {tc.input}</p>
                            <p className="font-mono text-xs"><strong>Output:</strong> {tc.expectedOutput}</p>
                        </div>
                    ))
                ) : (
                    <p className="text-xs text-muted-foreground">No example test cases provided.</p>
                )}
            </div>
        </div>
        
        <QuestionPalette statuses={state.statuses} currentIndex={state.currentQuestionIndex} dispatch={dispatch} />
        
        <AlertDialog>
            <TooltipProvider>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <div className="inline-block w-full">
                            <AlertDialogTrigger asChild>
                                <Button variant="destructive" size="lg" className="w-full" disabled={isSubmitting || isSubmitDisabled}>
                                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                End Exam
                                </Button>
                            </AlertDialogTrigger>
                        </div>
                    </TooltipTrigger>
                    {isSubmitDisabled && (
                    <TooltipContent>
                        <p>{submitButtonTooltip}</p>
                    </TooltipContent>
                    )}
                </Tooltip>
            </TooltipProvider>

            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>Are you sure you want to end the exam?</AlertDialogTitle>
                    <AlertDialogDescription>
                         This will submit your exam. You cannot make any more changes after submitting.
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel>Return to Exam</AlertDialogCancel>
                    <AlertDialogAction onClick={() => handleSubmitExam({ autoSubmitted: false, exitCount: exitCount })} disabled={isSubmitting}>
                        {isSubmitting ? 'Submitting...' : 'Submit Exam'}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}

    