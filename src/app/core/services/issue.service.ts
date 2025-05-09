import { Injectable } from '@angular/core';
import { BehaviorSubject, EMPTY, forkJoin, Observable, of, Subscription, throwError, timer } from 'rxjs';
import { catchError, exhaustMap, finalize, map, mergeMap } from 'rxjs/operators';
import { IssueComment } from '../models/comment.model';
import { GithubComment } from '../models/github/github-comment.model';
import RestGithubIssueFilter from '../models/github/github-issue-filter.model';
import { GithubIssue } from '../models/github/github-issue.model';
import { GithubLabel } from '../models/github/github-label.model';
import { HiddenData } from '../models/hidden-data.model';
import { IssueDispute } from '../models/issue-dispute.model';
import { FILTER, Issue, Issues, IssuesFilter, STATUS } from '../models/issue.model';
import { Phase } from '../models/phase.model';
import { appVersion } from './application.service';
import { DataService } from './data.service';
import { GithubService } from './github.service';
import { LoggingService } from './logging.service';
import { PhaseService } from './phase.service';
import { UserService } from './user.service';

@Injectable({
  providedIn: 'root'
})

/**
 * Responsible for creating and updating issues, and periodically fetching issues
 * using GitHub.
 */
export class IssueService {
  static readonly POLL_INTERVAL = 5000; // 5 seconds

  issues: Issues;
  issues$: BehaviorSubject<Issue[]>;

  private sessionId: string;
  private issueTeamFilter = 'All Teams';
  private issuesPollSubscription: Subscription;
  /** Whether the IssueService is downloading the data from Github*/
  public isLoading = new BehaviorSubject<boolean>(false);
  /** Whether the IssueService is creating a new team response */
  private isCreatingTeamResponse = false;

  constructor(
    private githubService: GithubService,
    private userService: UserService,
    private phaseService: PhaseService,
    private dataService: DataService,
    private logger: LoggingService
  ) {
    this.issues$ = new BehaviorSubject(new Array<Issue>());
  }

  startPollIssues() {
    if (this.issuesPollSubscription === undefined) {
      if (this.issues$.getValue().length === 0) {
        this.isLoading.next(true);
      }

      this.issuesPollSubscription = timer(0, IssueService.POLL_INTERVAL)
        .pipe(
          exhaustMap(() =>
            this.reloadAllIssues().pipe(
              catchError(() => EMPTY),
              finalize(() => this.isLoading.next(false))
            )
          )
        )
        .subscribe();
    }
  }

  stopPollIssues() {
    if (this.issuesPollSubscription) {
      this.issuesPollSubscription.unsubscribe();
      this.issuesPollSubscription = undefined;
    }
  }

  /**
   * Will constantly poll and update the application's state's with the updated issue.
   *
   * @param issueId - The issue's id to poll for.
   */
  pollIssue(issueId: number): Observable<Issue> {
    return timer(0, IssueService.POLL_INTERVAL).pipe(
      exhaustMap(() => {
        if (this.isCreatingTeamResponse) {
          return EMPTY;
        }
        return this.githubService.fetchIssueGraphql(issueId).pipe(
          map((response) => this.createAndSaveIssueModel(response)),
          catchError((err) => this.getIssue(issueId))
        );
      })
    );
  }

  reloadAllIssues() {
    return this.initializeData();
  }

  getIssue(id: number): Observable<Issue> {
    if (this.issues === undefined) {
      return this.getLatestIssue(id);
    } else {
      return of(this.issues[id]);
    }
  }

  getLatestIssue(id: number): Observable<Issue> {
    return this.githubService.fetchIssueGraphql(id).pipe(
      map((response: GithubIssue) => {
        this.createAndSaveIssueModel(response);
        return this.issues[id];
      }),
      catchError((err) => of(this.issues[id]))
    );
  }

  createIssue(title: string, description: string, severity: string, type: string): Observable<Issue> {
    const labelsArray = [this.createLabel('severity', severity), this.createLabel('type', type)];
    const clientType = 'Desktop';
    const hiddenData = new Map([
      ['session', this.sessionId],
      ['Version', `${clientType} v${appVersion}`]
    ]);
    const issueDescription = HiddenData.embedDataIntoString(description, hiddenData);
    return this.githubService
      .createIssue(title, issueDescription, labelsArray)
      .pipe(map((response: GithubIssue) => this.createIssueModel(response)));
  }

  updateIssue(issue: Issue): Observable<Issue> {
    return this.updateGithubIssue(issue).pipe(
      map((githubIssue: GithubIssue) => {
        githubIssue.comments = issue.githubComments;
        return this.createIssueModel(githubIssue);
      })
    );
  }

  /**
   * Updates an issue without attempting to create an issue model. Used when we want to treat
   * updateIssue as an atomic operation that only performs an API call.
   * @param issue current issue model
   * @returns GitHubIssue from the API request
   */
  updateGithubIssue(issue: Issue): Observable<GithubIssue> {
    const assignees = this.phaseService.currentPhase === Phase.phaseModeration ? [] : issue.assignees;
    return this.githubService
      .updateIssue(issue.id, issue.title, this.createGithubIssueDescription(issue), this.createLabelsForIssue(issue), assignees)
      .pipe(
        catchError((err) => {
          return this.parseUpdateIssueResponseError(err);
        })
      );
  }

  updateIssueWithComment(issue: Issue, issueComment: IssueComment): Observable<Issue> {
    return this.githubService.updateIssueComment(issueComment).pipe(
      mergeMap((updatedComment: GithubComment) => {
        issue.githubComments = [updatedComment, ...issue.githubComments.filter((c) => c.id !== updatedComment.id)];
        return this.updateIssue(issue);
      })
    );
  }

  updateTesterResponse(issue: Issue, issueComment: IssueComment): Observable<Issue> {
    const isTesterResponseExist = this.issues[issue.id].testerResponses;
    const commentApiToCall = isTesterResponseExist
      ? this.githubService.updateIssueComment(issueComment)
      : this.githubService.createIssueComment(issue.id, issueComment.description);

    const issueClone = issue.clone(this.phaseService.currentPhase);
    issueClone.status = STATUS.Done;

    return forkJoin([commentApiToCall, this.updateIssue(issueClone)]).pipe(
      map((responses) => {
        const [githubComment, issue] = responses;
        issue.updateTesterResponse(githubComment);
        return issue;
      })
    );
  }

  updateTutorResponse(issue: Issue, issueComment: IssueComment): Observable<Issue> {
    return forkJoin([this.githubService.updateIssueComment(issueComment), this.updateIssue(issue)]).pipe(
      map((responses) => {
        const [githubComment, issue] = responses;
        issue.updateDispute(githubComment);
        return issue;
      })
    );
  }

  createTeamResponse(issue: Issue): Observable<Issue> {
    // The issue must be updated first to ensure that fields like assignees are valid
    this.isCreatingTeamResponse = true;
    const teamResponse = issue.createGithubTeamResponse();
    return this.updateGithubIssue(issue).pipe(
      mergeMap((response: GithubIssue) => {
        return this.githubService.createIssueComment(issue.id, teamResponse).pipe(
          map((githubComment: GithubComment) => {
            this.isCreatingTeamResponse = false;
            issue.githubComments = [githubComment, ...issue.githubComments.filter((c) => c.id !== githubComment.id)];
            response.comments = issue.githubComments;
            return this.createIssueModel(response);
          })
        );
      })
    );
  }

  createTutorResponse(issue: Issue, response: string): Observable<Issue> {
    return forkJoin([this.githubService.createIssueComment(issue.id, response), this.updateIssue(issue)]).pipe(
      map((responses) => {
        const [githubComment, issue] = responses;
        issue.updateDispute(githubComment);
        return issue;
      })
    );
  }

  /**
   * This function will create a github representation of issue's description. Given the issue model, it will piece together the different
   * attributes to create the github's description.
   *
   */
  private createGithubIssueDescription(issue: Issue): string {
    switch (this.phaseService.currentPhase) {
      case Phase.phaseModeration:
        return (
          `# Issue Description\n${issue.createGithubIssueDescription()}\n# Team\'s Response\n${issue.teamResponse}\n ` +
          // `## State the duplicated issue here, if any\n${issue.duplicateOf ? `Duplicate of #${issue.duplicateOf}` : `--`}\n` +
          `# Disputes\n\n${this.getIssueDisputeString(issue.issueDisputes)}\n`
        );
      default:
        return issue.createGithubIssueDescription();
    }
  }

  private getIssueDisputeString(issueDisputes: IssueDispute[]): string {
    let issueDisputeString = '';
    for (const issueDispute of issueDisputes) {
      issueDisputeString += issueDispute.toString();
    }
    return issueDisputeString;
  }

  deleteIssue(id: number): Observable<Issue> {
    return this.githubService.closeIssue(id).pipe(map((response: GithubIssue) => this.createAndSaveIssueModel(response)));
  }

  undeleteIssue(id: number): Observable<Issue> {
    return this.githubService.reopenIssue(id).pipe(map((response: GithubIssue) => this.createAndSaveIssueModel(response)));
  }

  /**
   * This function will update the issue's state of the application. This function needs to be called whenever a issue is deleted.
   */
  deleteFromLocalStore(issueToDelete: Issue) {
    const { [issueToDelete.id]: issueToRemove, ...withoutIssueToRemove } = this.issues;
    this.issues = withoutIssueToRemove;
    this.issues$.next(Object.values(this.issues));
  }

  /**
   * This function will update the issue's state of the application. This function needs to be called whenever a issue is added/updated.
   */
  updateLocalStore(issueToUpdate: Issue) {
    this.issues = {
      ...this.issues,
      [issueToUpdate.id]: issueToUpdate
    };
    this.issues$.next(Object.values(this.issues));
  }

  /**
   * Check whether the issue has been responded in the phase 2/3.
   */
  hasTeamResponse(issueId: number): boolean {
    return !!this.issues[issueId].teamResponse;
  }

  /**
   * Obtain an observable containing an array of issues that are duplicates of the parentIssue.
   */
  getDuplicateIssuesFor(parentIssue: Issue): Observable<Issue[]> {
    return this.issues$.pipe(map((issues) => issues.filter((issue) => issue.duplicateOf === parentIssue.id)));
  }

  reset(resetSessionId: boolean) {
    if (resetSessionId) {
      this.sessionId = undefined;
    }

    this.issues = undefined;
    this.issues$.next(new Array<Issue>());

    this.stopPollIssues();
    this.isLoading.complete();
    this.isLoading = new BehaviorSubject<boolean>(false);
  }

  private initializeData(): Observable<Issue[]> {
    const issuesAPICallsByFilter: Array<Observable<Array<GithubIssue>>> = [];

    let filter: RestGithubIssueFilter = new RestGithubIssueFilter({});
    if (this.phaseService.requireLoadClosedIssues()) {
      filter.state = 'all';
    }

    switch (IssuesFilter[this.phaseService.currentPhase][this.userService.currentUser.role]) {
      case FILTER.FilterByCreator: {
        filter.creator = this.userService.currentUser.loginId;
        issuesAPICallsByFilter.push(this.githubService.fetchIssuesGraphql(filter));
        break;
      }
      case FILTER.FilterByTeam: // Only student has this filter
        issuesAPICallsByFilter.push(
          this.githubService.fetchIssuesGraphqlByTeam(
            this.createLabel('tutorial', this.userService.currentUser.team.tutorialClassId),
            this.createLabel('team', this.userService.currentUser.team.teamId),
            filter
          )
        );
        break;
      case FILTER.FilterByTeamAssigned: // Only for Tutors and Admins
        const allocatedTeams = this.userService.currentUser.allocatedTeams;
        allocatedTeams.forEach((team) => {
          issuesAPICallsByFilter.push(
            this.githubService.fetchIssuesGraphqlByTeam(
              this.createLabel('tutorial', team.tutorialClassId),
              this.createLabel('team', team.teamId),
              filter
            )
          );
        });
        break;
      case FILTER.NoFilter:
        issuesAPICallsByFilter.push(this.githubService.fetchIssuesGraphql(filter));
        break;
      case FILTER.NoAccess:
      default:
        return of([]);
    }

    // const issuesAPICallsByFilter = filters.map(filter => this.githubService.fetchIssuesGraphql(filter));
    return forkJoin(issuesAPICallsByFilter).pipe(
      map((issuesByFilter: [][]) => {
        const fetchedIssueIds: Array<Number> = [];

        for (const issues of issuesByFilter) {
          for (const issue of issues) {
            fetchedIssueIds.push(this.createIssueModel(issue).id);
            this.createAndSaveIssueModel(issue);
          }
        }

        const outdatedIssueIds: Array<Number> = this.getOutdatedIssueIds(fetchedIssueIds);
        this.deleteIssuesFromLocalStore(outdatedIssueIds);

        return Object.values(this.issues);
      })
    );
  }

  private createAndSaveIssueModel(githubIssue: GithubIssue): Issue {
    const issue = this.createIssueModel(githubIssue);
    this.updateLocalStore(issue);
    return issue;
  }

  private deleteIssuesFromLocalStore(ids: Array<Number>): void {
    ids.forEach((id: number) => {
      this.getIssue(id).subscribe((issue) => this.deleteFromLocalStore(issue));
    });
  }

  /**
   * Returns an array of outdated issue ids by comparing the ids of the recently
   * fetched issues with the current issue ids in the local store
   */
  private getOutdatedIssueIds(fetchedIssueIds: Array<Number>): Array<Number> {
    /*
      Ignore for first fetch or ignore if there is no fetch result

      We also have to ignore for no fetch result as the cache might return a
      304 reponse with no differences in issues, resulting in the fetchIssueIds
      to be empty
    */
    if (this.issues === undefined || !fetchedIssueIds.length) {
      return [];
    }

    const fetchedIssueIdsSet = new Set<Number>(fetchedIssueIds);

    const result = Object.keys(this.issues)
      .map((x) => +x)
      .filter((issueId) => !fetchedIssueIdsSet.has(issueId));

    return result;
  }

  /**
   * Given an issue model, create the necessary labels for github.
   */
  private createLabelsForIssue(issue: Issue): string[] {
    const result = [];

    if (
      this.phaseService.currentPhase !== Phase.phaseBugReporting &&
      this.phaseService.currentPhase !== Phase.phaseBugTrimming &&
      this.phaseService.currentPhase !== Phase.phaseTesterResponse
    ) {
      const studentTeam = issue.teamAssigned.id.split('-');
      result.push(this.createLabel('tutorial', `${studentTeam[0]}-${studentTeam[1]}`), this.createLabel('team', studentTeam[2]));
    }

    if (issue.severity) {
      result.push(this.createLabel('severity', issue.severity));
    }

    if (issue.type) {
      result.push(this.createLabel('type', issue.type));
    }

    if (issue.response) {
      result.push(this.createLabel('response', issue.response));
    }

    if (issue.duplicated) {
      result.push('duplicate');
    }

    if (issue.status) {
      result.push(this.createLabel('status', issue.status));
    }

    if (issue.pending) {
      if (+issue.pending > 0) {
        result.push(this.createLabel('pending', issue.pending));
      }
    }

    if (issue.unsure) {
      result.push('unsure');
    }

    return result;
  }

  private createLabel(prepend: string, value: string) {
    return `${prepend}.${value}`;
  }

  private extractTeamIdFromGithubIssue(githubIssue: GithubIssue): string {
    return githubIssue.findLabel(GithubLabel.LABELS.tutorial).concat('-').concat(githubIssue.findLabel(GithubLabel.LABELS.team));
  }

  private createIssueModel(githubIssue: GithubIssue): Issue {
    let issue: Issue;

    switch (this.phaseService.currentPhase) {
      case Phase.phaseBugReporting:
        issue = Issue.createPhaseBugReportingIssue(githubIssue);
        break;
      case Phase.phaseBugTrimming:
        issue = Issue.createPhaseBugTrimmingIssue(githubIssue);
        break;
      case Phase.phaseTeamResponse:
        issue = Issue.createPhaseTeamResponseIssue(githubIssue, this.dataService.getTeam(this.extractTeamIdFromGithubIssue(githubIssue)));
        break;
      case Phase.phaseTesterResponse:
        issue = Issue.createPhaseTesterResponseIssue(githubIssue);
        break;
      case Phase.phaseModeration:
        issue = Issue.createPhaseModerationIssue(githubIssue, this.dataService.getTeam(this.extractTeamIdFromGithubIssue(githubIssue)));
        break;
      default:
        return;
    }

    if (issue.parseError) {
      this.logger.error('IssueService: ' + issue.parseError);
    }
    return issue;
  }

  private parseUpdateIssueResponseError(err: any) {
    this.logger.error('IssueService: ', err); // Log full details of error first

    if (err.code !== 422 || !err.hasOwnProperty('message')) {
      return throwError(err.response.data.message); // More readable error message
    }

    // Error code 422 implies that one of the fields are invalid
    const validationFailedPrefix = 'Validation Failed:';
    const message: string = err.message;
    const errorJsonRaw = message.substring(validationFailedPrefix.length);
    const errorJson = JSON.parse(errorJsonRaw);

    const mandatoryFields = ['field', 'code', 'value'];
    const hasMandatoryFields = mandatoryFields.every((field) => errorJson.hasOwnProperty(field));

    if (hasMandatoryFields) {
      if (errorJson['field'] === 'assignees' && errorJson['code'] === 'invalid') {
        // If assignees are invalid, return a custom error
        return throwError(
          `Assignee ${errorJson['value']} has not joined your organization yet. Please remove them from the assignees list.`
        );
      }
    }

    // Generic 422 Validation Failed since it is not an assignees problem
    return throwError(err.response.data.message);
  }

  setIssueTeamFilter(filterValue: string) {
    if (filterValue) {
      this.issueTeamFilter = filterValue;
    }
  }

  setSessionId(sessionId: string) {
    this.sessionId = sessionId;
  }

  getIssueTeamFilter(): string {
    return this.issueTeamFilter;
  }
}
