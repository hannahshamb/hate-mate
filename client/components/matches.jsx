import React from 'react';
import AppContext from '../lib/app-context';

export default class Matches extends React.Component {

  constructor(props) {
    super(props);
    this.state = {
      isLoading: true,
      linkText: 'view all'
    };
    this.handleSubmit = this.handleSubmit.bind(this);
    this.handleExpandList = this.handleExpandList.bind(this);
  }

  handleSubmit(event) {
    event.preventDefault();
    const { user } = this.context;
    const status = event.target.getAttribute('action');
    const currentUserId = user.userId;
    const otherUserId = parseInt(event.target.getAttribute('userid'));
    let userId1;
    let userId2;
    let statusToUpdate;

    if (currentUserId < otherUserId) {
      userId1 = currentUserId;
      userId2 = otherUserId;
      statusToUpdate = 'user1Status';
    } else {
      userId1 = otherUserId;
      userId2 = currentUserId;
      statusToUpdate = 'user2Status';
    }
    const xaccesstoken = localStorage.getItem('react-context-jwt');
    const req = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-access-token': xaccesstoken
      }
    };
    req.body = JSON.stringify({
      userId1, userId2, statusToUpdate, status
    });

    fetch('/api/match-status-update', req)
      .then(res => res.json())
      .then(result => {
        const { matchesToDisplay } = this.state;

        const matchesToDisplayCopy = matchesToDisplay.map((match, i) => {
          if (userId1 === match.userId1 && userId2 === match.userId2) {
            match.newUserStatus = status;
          }
          return match;
        });
        this.setState({ matchesToDisplay: matchesToDisplayCopy });
      });

  }

  handleClick() {
    window.location.hash = 'match-list';
  }

  handleExpandList(event) {
    const expanded = event.target.parentNode.getAttribute('aria-expanded');
    if (expanded === 'true') {
      this.setState({ linkText: 'see less' });
    } else {
      this.setState({ linkText: 'view all' });
    }
  }

  componentDidMount() {
    const { user } = this.context;
    const xaccesstoken = localStorage.getItem('react-context-jwt');
    const req = {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-access-token': xaccesstoken
      }
    };

    fetch('/api/auth/find-matches/', req)
      .then(res => res.json())
      .then(result => {
        if (result !== 'no potential matches exist') {
          const { potentialMatches, matchSelections } = result;
          const otherUsers = [];
          // add demo id to unique other user
          const uniqueOtherUsers = potentialMatches.map(potentialMatch => {
            return { userId: potentialMatch.userId, demoId: potentialMatch.demoId };
          });
          if (matchSelections.length !== 0) {
            matchSelections.forEach(matchSelection => {
              let otherUser;
              if (matchSelection.userId1 === user.userId) {
                otherUser = matchSelection.userId2;
              } else {
                otherUser = matchSelection.userId1;
              }
              otherUsers.push(otherUser);
            });
          }
          const allMatchTypes = [];
          uniqueOtherUsers.forEach(uniqueOtherUser => {
            let count = 0;
            let matchType = '';
            if (otherUsers.length !== 0) {
              otherUsers.forEach(occurance => {
                if (uniqueOtherUser.userId === occurance) {
                  count++;
                }
              });
            }
            if (count === 0) {
              matchType = 'no longer a match';
            } else if (count <= 4) {
              matchType = 'good';
            } else if (count <= 9) {
              matchType = 'great';
            } else if (count === 10) {
              matchType = 'perfect';
            }
            let userId1;
            let userId2;
            let demoId1;
            let demoId2;
            if (user.userId < uniqueOtherUser.userId) {
              userId1 = user.userId;
              demoId1 = user.demoId;
              userId2 = uniqueOtherUser.userId;
              demoId2 = uniqueOtherUser.demoId;
            } else {
              userId1 = uniqueOtherUser.userId;
              demoId1 = uniqueOtherUser.demoId;
              userId2 = user.userId;
              demoId2 = user.demoId;
            }
            allMatchTypes.push({
              userId1,
              demoId1,
              userId2,
              demoId2,
              matchType
            });

          });

          allMatchTypes.forEach(matchType => {
            potentialMatches.forEach((potentialMatch, i) => {
              if (potentialMatch.userId === matchType.userId1 || potentialMatch.userId === matchType.userId2) {
                potentialMatches[i].matchType = matchType.matchType;
              }
            });
          });
          this.setState({ potentialMatches, matchSelections });
          const body = {
            matchSelections, allMatchTypes, user
          };
          req.method = 'POST';
          req.body = JSON.stringify(body);

          fetch('/api/auth/post-matches/', req)
            .then(res => res.json())
            .then(result => {
              const matchStatuses = result;
              const matchesToDisplay = [];

              if (potentialMatches.length <= matchStatuses.length) {
                potentialMatches.forEach(potentialMatch => {
                  let currentUser;
                  matchStatuses.forEach(matchStatus => {
                    if (potentialMatch.userId === matchStatus.userId1 || potentialMatch.userId === matchStatus.userId2) {
                      potentialMatch.userId1 = matchStatus.userId1;
                      potentialMatch.userId2 = matchStatus.userId2;
                      if (user.userId === matchStatus.userId1) {
                        currentUser = 'userId1';
                      } else {
                        currentUser = 'userId2';
                      }
                      potentialMatch.user1Status = matchStatus.user1Status;
                      potentialMatch.user2Status = matchStatus.user2Status;
                      potentialMatch.matchStatus = matchStatus.matchStatus;
                      potentialMatch.matchSelections = matchStatus.matchSelections;
                      potentialMatch.matchType = matchStatus.matchType;
                      potentialMatch.newUserStatus = 'pending';
                    }
                  });
                  if (currentUser === 'userId1') {
                    if (potentialMatch.matchStatus === 'pending' && potentialMatch.user1Status === 'pending' && potentialMatch.matchType !== 'no longer a match') {
                      matchesToDisplay.push(potentialMatch);
                    }
                  } else if (currentUser === 'userId2') {
                    if (potentialMatch.matchStatus === 'pending' && potentialMatch.user2Status === 'pending' && potentialMatch.matchType !== 'no longer a match') {
                      matchesToDisplay.push(potentialMatch);
                    }
                  }

                });
              } else {
                matchStatuses.forEach(matchStatus => {
                  let currentUser;
                  potentialMatches.forEach(potentialMatch => {
                    if (potentialMatch.userId === matchStatus.userId1 || potentialMatch.userId === matchStatus.userId2) {
                      potentialMatch.userId1 = matchStatus.userId1;
                      potentialMatch.userId2 = matchStatus.userId2;
                      if (user.userId === matchStatus.userId1) {
                        currentUser = 'userId1';
                      } else {
                        currentUser = 'userId2';
                      }
                      potentialMatch.user1Status = matchStatus.user1Status;
                      potentialMatch.user2Status = matchStatus.user2Status;
                      potentialMatch.matchStatus = matchStatus.matchStatus;
                      potentialMatch.matchSelections = matchStatus.matchSelections;
                      potentialMatch.newUserStatus = 'pending';
                      potentialMatch.matchType = matchStatus.matchType;
                      if (currentUser === 'userId1') {
                        if (potentialMatch.matchStatus === 'pending' && potentialMatch.user1Status === 'pending' && potentialMatch.matchType !== 'no longer a match') {
                          matchesToDisplay.push(potentialMatch);
                        }
                      } else if (currentUser === 'userId2') {
                        if (potentialMatch.matchStatus === 'pending' && potentialMatch.user2Status === 'pending' && potentialMatch.matchType !== 'no longer a match') {
                          matchesToDisplay.push(potentialMatch);
                        }
                      }
                    }
                  });
                });
              }
              this.setState({ matchesToDisplay, isLoading: false });
            });

        }
        this.setState({ isLoading: false });
      });
  }

  render() {

    let userId;
    let age;
    let fileName;
    let firstName;
    let gender;
    let mileage;
    let url;
    let matchType;
    let matchSelections;
    let moreThan3 = false;

    const { matchesToDisplay, isLoading, linkText } = this.state;
    if (matchesToDisplay !== undefined) {
      for (let i = 0; i < matchesToDisplay.length; i++) {
        if (matchesToDisplay[i].newUserStatus === 'pending') {
          ({ userId, age, fileName, firstName, gender, mileage, url, matchSelections, matchType } = matchesToDisplay[i]);
          if (matchSelections.length > 3) {
            moreThan3 = true;
          }
          break;
        }
      }
    }

    const formStyle = {
      width: '100%',
      maxWidth: '900px',
      backgroundColor: 'none'
    };

    const cardStyle = {
      height: '100%',
      minHeight: 'calc(100vh - 700px)',
      backgroundColor: '#F0F0F0'
    };

    let profilePicture = (
      <div className="rounded-circle text-center d-flex justify-content-center align-items-center " style={{ width: '120px', height: '120px', backgroundColor: '#D9D9D9' }}>
        <i className="fa-solid fa-user fa-xl" style={{ color: '#6D6969' }}></i>
      </div>);

    if (url !== null) {
      profilePicture = (
      <div className="rounded-circle text-center d-flex justify-content-center align-items-center" style={{ width: '120px', height: '120px' }}>
        <a><img className='profile-picture' style={{ width: '120px', height: '120px' }} src={url} alt={fileName} /></a>
      </div>
      );
    }

    let matchTypeDescription;
    if (matchType !== undefined) {
      matchTypeDescription = `${matchType[0].toUpperCase() + matchType.substring(1)} Match!`;
    }

    let matchTypeClass;
    if (matchTypeDescription === 'Perfect Match!') {
      matchTypeClass = 'yellow';
    } else if (matchTypeDescription === 'Great Match!') {
      matchTypeClass = 'green';
    } else if (matchTypeDescription === 'Good Match!') {
      matchTypeClass = 'danger';
    }

    return (
      <div className='vh-100 text-center d-flex flex-column align-items-center justify-content-center'>
        {isLoading
          ? (
        <div className="row">
          <h1><i className="fa-solid fa-spinner fa-lg danger spin spinner"></i></h1>
        </div>
            )
          : (
              userId
                ? (
        <div className="row">
          <form style={formStyle} className='px-2'>
            <div className="row card border-0 shadow p-2 m-0 text-start d-flex align-items-center justify-content-center box-sizing dynamic-width" style={cardStyle}>
              <div className="row row-cols-lg-1 row-cols-sm-2 m-0 p-0">
                <div className="col-4 d-flex justify-content-center pt-2 px-0">
                  {profilePicture}
                </div>
                <div className="col-8 d-flex justify-content-center pt-2 px-0 ">
                  <div className="row w-100 row-cols-1">
                    <div className="col d-flex justify-content-center px-0">
                      <h1>{firstName}</h1>
                    </div>
                    <div className="col d-flex justify-content-center px-0">
                          <p className='m-0 form-font'>{`${gender[0].toUpperCase() + gender.substring(1)}, ${age} years old`}</p>
                    </div>
                    <div className="col d-flex justify-content-center px-0">
                      <p className='m-0 form-font'><span className='ps-0 pe-1'><i className="fa-solid fa-location-dot"></i></span>{`${mileage} miles away`}</p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="row mt-4">
                <div className={`col d-flex justify-content-center ${matchTypeClass}`}>
                      <h5>{matchTypeDescription}</h5>
                </div>
              </div>

              <div className="row mt-1">
                <div className="col d-flex justify-content-center">
                  <ol className='m-0 p-0'>
                    {matchSelections.map((selection, index) => {
                      let li;
                      if (index < 3) {
                        li = <li id={`selection${index}`} key={index}>{`hates ${selection.selectionName}`}</li>;
                      } else if (index >= 3) {
                        li = (
                          <li className='collapse collapse-li' id={`selection${index}`} key={index}>{`hates ${selection.selectionName}`}</li>
                        );
                      }
                      return li;
                    })}
                  </ol>
                </div>
              </div>

              <div className="row mb-3">
                <div className="col d-flex justify-content-end me-lg-4">
                    {moreThan3
                      ? (
                            <button id="view-all-collapse" className="btn-link red-link p-0 m-0 justify-content-end" type="button" data-bs-toggle="collapse" data-bs-target=".collapse-li" aria-expanded='true' aria-controls="selection3 selection4 selection5 selection6 selection7 selection8 selection9" onClick={this.handleExpandList}><u>{linkText}</u></button>
                        )
                      : (<></>) }

                </div>
              </div>

              <div className="row d-flex justify-content-between mt-0 mb-3 p-0">
                <div className="col d-flex justify-content-center px-0">
                    <button type='submit' className="lt-red-btn px-2 m-0 confirm-cancel-btn" action='rejected' userid={userId} onClick={this.handleSubmit}>
                    Decline
                  </button>
                </div>
                <div className="col d-flex justify-content-center px-0">
                  <button type='submit' className='confirm-btn lt-red-btn px-2 m-0 confirm-cancel-btn' action='accepted' userid={userId} onClick={this.handleSubmit}>
                    Accept
                  </button>
                </div>

              </div>
            </div>
          </form>
        </div>
                  )
                : (
      <>
        <div className='row mb-5'>
          <div className='col'>
            <h1>PENDING MATCHES</h1>
          </div>
        </div>
        <div className="row">
          <div className="col">
            <p className='px-3'>No Pending Matches! &#128557; </p>
          </div>
        </div>
        <div className="row w-100 m-5">
          <div className="col d-flex justify-content-center">
            <button onClick={this.handleClick} className='lt-red-btn retake-quiz-btn px-1 mt-1 mx-0'>
              View Matches
            </button>
          </div>
        </div>
      </>
                  )
            )}
      </div>
    );
  }
}

Matches.contextType = AppContext;
